// Planning verifiers must fail on empty, pass on correct, fail on plausible-wrong.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyMigrationPlan, verifyIncidentRunbook } from "../eval/planning-verifiers.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(cond ? "PASS" : "FAIL", name, cond ? "" : detail);
  if (!cond) failed++;
}
const dir = mkdtempSync(join(tmpdir(), "plan-verify-"));
const put = (name: string, text: string) => writeFileSync(join(dir, name), text);

// ---------- migration ----------
check("migration: empty state fails", !(await verifyMigrationPlan(dir)).ok);

put("migration-plan.md", `# Migration plan: split full_name into first_name and last_name

## Release 1 (expand)
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes: every write to full_name also writes first_name and last_name.
3. Backfill existing rows by splitting full_name into the two new columns in batches.
4. Verify the backfill: count rows where the new columns are null.

## Release 2 (switch)
5. Switch reads to first_name and last_name. full_name is still written for the previous release.
6. Monitor for one release cycle.

## Release 3 (contract)
7. Stop writing to the old full_name column.
8. In the next release after writes stop, drop the old column full_name.

## Rollback
Each release can be rolled back independently because the previous columns are still present and written until the next release.
`);
const good = await verifyMigrationPlan(dir);
check("migration: correct plan passes", good.ok, good.message);

// Plausible wrong: drops the column in the same release it stops writing.
put("migration-plan.md", `# Migration plan

## Context
The service runs two releases side by side during deploys. Every step below must hold while the previous release is still serving traffic.

## Release 1
1. Add the new columns first_name and last_name.
2. Deploy code that dual-writes both old and new columns.
3. Backfill existing rows from full_name.
4. Switch reads to the new columns.

## Release 2
5. Stop writing to the old full_name column and drop the old column in this release.

## Rollback
Restore from the previous deploy.
`);
const bad = await verifyMigrationPlan(dir);
check("migration: same-release drop fails", !bad.ok);
check("migration: names the release boundary", bad.message.includes("same release"), bad.message);

// Plausible wrong: reads switch before backfill.
put("migration-plan.md", `# Plan

## Context
The service runs two releases side by side during deploys. Every step below must hold while the previous release is still serving traffic.

1. Add the new column last_name.
2. Deploy dual-write so both columns are written.
3. Switch reads to last_name.
4. Backfill existing rows.
5. Stop writing the old column.
6. In a later release, drop the old column.
Rollback: revert.
`);
const early = await verifyMigrationPlan(dir);
check("migration: reads before backfill fails", !early.ok && early.message.includes("before the backfill"), early.message);

// The switch-read step must not match a write-path step that merely mentions
// reads staying unchanged. This is the exact sentence that fooled the first
// version.
put("migration-plan.md", `# Plan

## Context
Two releases run side by side during every deploy, so each step must keep working while the previous release serves traffic.

## Release N
1. Add the new columns first_name and last_name.
2. Update all write paths (create/update user) to write both old and new columns. Reads still use full_name exclusively (no behavior change on the read path yet).
## Release N+1
3. Backfill existing rows in batches.
4. Switch all reads to first_name and last_name.
5. Stop writing the old full_name column.
## Release N+2
6. Drop the old column.

## Rollback
Revert the release.
`);
const tricky = await verifyMigrationPlan(dir);
check("migration: write-path step mentioning reads is not the switch", tricky.ok, tricky.message);

// ---------- fix round 2: negative controls the broadened detectors let through ----------
// A code-review pass on the 2026-09-26 fixes above found five of them wider
// than the bugs they fixed, each one letting a genuinely wrong plan pass.
// Every plan below is wrong and must still fail after the narrowing fix.
const CTX = `## Context
Two releases run side by side during every deploy, so each step must keep working while the previous release serves traffic.
`;

// Finding 1: "write X and Y together" without the old column present is not
// a dual-write - it only ever mentions the new columns.
put("migration-plan.md", `# Plan
${CTX}
## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that writes first_name and last_name together in one transaction on every name change.
## Release 2
3. Backfill existing rows from full_name in batches.
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop the old column full_name.

## Rollback
Revert.
`);
const togetherNoOld = await verifyMigrationPlan(dir);
check("migration: 'together' without the old column is not dual-write", !togetherNoOld.ok, togetherNoOld.message);

// Finding 2: same-release drop, phrased so the drop sentence also mentions
// the ORM. An unanchored ORM reject would hide this real same-release drop.
put("migration-plan.md", `# Plan
${CTX}
## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column.
6. Drop the full_name column and remove it from the ORM model.
## Release 4
7. Drop the leftover index on the old column.

## Rollback
Revert.
`);
const ormSameReleaseDrop = await verifyMigrationPlan(dir);
check("migration: drop mentioning the ORM in the same sentence still same-release-fails", !ormSameReleaseDrop.ok, ormSameReleaseDrop.message);

// Finding 3: a real release-phase heading that happens to say "logic" must
// not be swallowed as a definitional preamble - its own step (an early,
// wrong read switch) must still be read and still fail the order check.
put("migration-plan.md", `# Plan
${CTX}
## Release 1: expand
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
## Release 2: read logic
3. Switch reads to first_name and last_name.
## Release 3: backfill
4. Backfill existing rows from full_name.
5. Confirm all reads use first_name and last_name.
## Release 4
6. Stop writing to the old full_name column.
## Release 5
7. Drop the old column full_name.

## Rollback
Revert.
`);
const logicHeading = await verifyMigrationPlan(dir);
check("migration: a 'read logic' release heading is not a preamble skip", !logicHeading.ok, logicHeading.message);
check("migration: still names the early-switch order violation", logicHeading.message.includes("before the backfill"), logicHeading.message);

// Finding 4: writes stop before reads switch (wrong order), with a spurious
// "reads ... use a snapshot" sentence in the backfill step that must not be
// read as switching reads to the new column (it names no new column at all).
put("migration-plan.md", `# Plan
${CTX}
## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
3. Backfill existing rows from full_name; reads from the replica use a snapshot during the job.
## Release 2
4. Stop writing to the old full_name column.
## Release 3
5. Switch reads to first_name and last_name.
## Release 4
6. Drop the old column full_name.

## Rollback
Revert.
`);
const stopBeforeSwitch = await verifyMigrationPlan(dir);
check("migration: stop-write before switch-reads still fails", !stopBeforeSwitch.ok, stopBeforeSwitch.message);
check("migration: names the write-before-switch order violation", stopBeforeSwitch.message.includes("reads still come from it"), stopBeforeSwitch.message);

// Positive control for finding 4: a correct plan whose dual-write step says
// "Reads come from full_name" (the OLD column) must still pass - the
// read-first switchRead form must not treat this as switching reads.
put("migration-plan.md", `# Plan
${CTX}
## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns. Reads come from full_name.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop the old column full_name.

## Rollback
Revert.
`);
const readsFromOldStillCorrect = await verifyMigrationPlan(dir);
check("migration: 'reads come from full_name' in the dual-write step still passes", readsFromOldStillCorrect.ok, readsFromOldStillCorrect.message);

// Finding 7: same-release drop using qualified `users.full_name`-style
// names - the dot-masking fix must not let the qualified name hide a real
// same-release drop the way it un-hid the correct plans' phase detection.
put("migration-plan.md", `# Plan
${CTX}
## Release 1
1. Add nullable users.first_name and users.last_name columns.
2. Deploy dual-write so both users.full_name and the new columns are written.
3. Backfill existing rows.
## Release 2
4. Switch reads to users.first_name and users.last_name.
## Release 3
5. Stop writing users.full_name and drop the users.full_name column.

## Rollback
Revert.
`);
const qualifiedSameReleaseDrop = await verifyMigrationPlan(dir);
check("migration: qualified-name same-release drop still fails", !qualifiedSameReleaseDrop.ok, qualifiedSameReleaseDrop.message);

// Finding 7: same-release drop where the DROP COLUMN itself is fenced SQL -
// the fence-continuation fix must not let the fence hide a real
// same-release drop the way it un-hid Opus's correct, later-release drop.
put("migration-plan.md", `# Plan
${CTX}
## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column, then run:

\`\`\`sql
ALTER TABLE users DROP COLUMN full_name;
\`\`\`

## Rollback
Revert.
`);
const fencedSameReleaseDrop = await verifyMigrationPlan(dir);
check("migration: fenced same-release drop still fails", !fencedSameReleaseDrop.ok, fencedSameReleaseDrop.message);

// ---------- incident ----------
rmSync(join(dir, "migration-plan.md"));
check("incident: empty state fails", !(await verifyIncidentRunbook(dir)).ok);

put("incident-runbook.md", `# Incident: multi-system outage

## Steps
1. Declare the incident and open the bridge. Owner: on-call SRE
2. Confirm the database is healthy and accepting connections. Owner: DBA
3. Restore the database replica if lag exceeds five minutes. Owner: DBA
4. Restart the queue consumers and confirm the backlog drains. Owner: platform
5. Clear and warm the cache from the confirmed-healthy database. Owner: backend
6. Re-enable the api gateway routes one by one. Owner: platform
7. Verify end-to-end: place a synthetic order and confirm it lands. Owner: on-call SRE

## Rollback
If step 6 raises the error rate, disable the routes again and hold at step 5.
`);
const okInc = await verifyIncidentRunbook(dir);
check("incident: correct runbook passes", okInc.ok, okInc.message);

// Plausible wrong: cache warmed before the database is confirmed.
put("incident-runbook.md", `# Incident

## Context
The database, queue, api gateway and cache all degraded after a network partition. Recover them in dependency order.

## Steps
1. Declare the incident. Owner: on-call SRE
2. Clear and warm the cache. Owner: backend
3. Confirm the database is healthy. Owner: DBA
4. Restart the queue consumers. Owner: platform
5. Re-enable the api gateway. Owner: platform
6. Verify end to end. Owner: on-call SRE

## Rollback
Revert.
`);
const badInc = await verifyIncidentRunbook(dir);
check("incident: cache before database fails", !badInc.ok && badInc.message.includes("cache is warmed"), badInc.message);

// Plausible wrong: a step with no owner.
put("incident-runbook.md", `# Incident

## Context
The database, queue, api gateway and cache all degraded after a network partition. Recover them in dependency order.

## Steps
1. Declare the incident. Owner: on-call SRE
2. Confirm the database is healthy. Owner: DBA
3. Restart the queue consumers.
4. Warm the cache. Owner: backend
5. Re-enable the api gateway. Owner: platform
6. Verify end to end. Owner: on-call SRE

## Rollback
Revert.
`);
const noOwner = await verifyIncidentRunbook(dir);
check("incident: ownerless step fails", !noOwner.ok && noOwner.message.includes("no owner"), noOwner.message);

rmSync(dir, { recursive: true, force: true });

// ---------- real model output as positive control ----------
// Both were produced by claude-sonnet-5 and are correct plans. The first
// verifier version rejected both; a verifier that fails a correct plan from
// the strongest model measures itself, not the model.
import { copyFileSync } from "node:fs";
const dir2 = mkdtempSync(join(tmpdir(), "plan-verify-real-"));
copyFileSync(join(import.meta.dirname, "fixtures", "sonnet-migration-plan.md"), join(dir2, "migration-plan.md"));
const realMig = await verifyMigrationPlan(dir2);
check("real Sonnet migration plan passes", realMig.ok, realMig.message);
// Two more real Sonnet plans. One uses "**Step N.**" numbering and says
// "do not drop … yet"; the other says "used by the backfill job". Each
// broke an earlier verifier version.
for (const name of ["sonnet-migration-plan-2.md", "sonnet-migration-plan-3.md"]) {
  copyFileSync(join(import.meta.dirname, "fixtures", name), join(dir2, "migration-plan.md"));
  const r = await verifyMigrationPlan(dir2);
  check(`real ${name} passes`, r.ok, r.message);
}
rmSync(join(dir2, "migration-plan.md"));
copyFileSync(join(import.meta.dirname, "fixtures", "sonnet-incident-runbook.md"), join(dir2, "incident-runbook.md"));
const realInc = await verifyIncidentRunbook(dir2);
check("real Sonnet incident runbook passes", realInc.ok, realInc.message);
rmSync(join(dir2, "incident-runbook.md"));

// ---------- real frontier-model output, measured 2026-09-26 ----------
// Three plans from the Task 9 frontier benchmark that the first pass of
// this run's verifier rejected. Each rejection was a verifier bug, not a
// bad plan: a qualified reference's "." (`users.full_name`) broke the
// same-sentence "[^.]" windows several detectors use, a fenced DDL block's
// upper-case SQL broke the plain-paragraph continuation heuristic so the
// real DROP COLUMN step lost its text, and a "Business Rules" heading
// wasn't recognised as preamble so its own numbered list of naming rules
// was read as steps 1-4, ahead of the real ones.
copyFileSync(join(import.meta.dirname, "fixtures", "opus-migration-plan-fenced-drop.md"), join(dir2, "migration-plan.md"));
const opusReal = await verifyMigrationPlan(dir2);
check("real Opus plan (fenced DROP COLUMN) passes", opusReal.ok, opusReal.message);
rmSync(join(dir2, "migration-plan.md"));

copyFileSync(join(import.meta.dirname, "fixtures", "gpt6sol-migration-plan-qualified-names.md"), join(dir2, "migration-plan.md"));
const gpt6solReal = await verifyMigrationPlan(dir2);
check("real gpt-6-sol plan (users.full_name qualified names) passes", gpt6solReal.ok, gpt6solReal.message);
rmSync(join(dir2, "migration-plan.md"));

copyFileSync(join(import.meta.dirname, "fixtures", "gemini-migration-plan-business-rules.md"), join(dir2, "migration-plan.md"));
const geminiReal = await verifyMigrationPlan(dir2);
check("real Gemini plan (Business Rules numbered list) passes", geminiReal.ok, geminiReal.message);
rmSync(join(dir2, "migration-plan.md"));

// Produced by google/gemini-3.8-flash, second frontier-benchmark pass
// (2026-09-26). Left as a FAIL in the first fix round: its write cutover
// is stated only object-first ("Deploy Application Code with Old Writes
// Removed", "Write Path: Exclusively first_name and last_name"), which the
// verb-first stopWrite detector never matched. Fixed in round 2 by adding
// that object-first form (finding 6 of the round-2 review).
copyFileSync(join(import.meta.dirname, "fixtures", "gemini-migration-plan-object-first-stopwrite.md"), join(dir2, "migration-plan.md"));
const geminiObjectFirst = await verifyMigrationPlan(dir2);
check("real Gemini plan (object-first stop-write phrasing) passes", geminiObjectFirst.ok, geminiObjectFirst.message);
rmSync(join(dir2, "migration-plan.md"));

rmSync(dir2, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
