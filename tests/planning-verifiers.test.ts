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

// ---------- fix round 3: every probe sentence from the round-2 re-review ----------
// Controller ruling R12: every probe sentence from both code-review passes
// becomes a committed test. These are the round-2 re-review's cases
// (mined from t9r2/probes.ts): findings 2, 3 and 6 were not actually fixed
// by round 2's changes, and round 2 introduced a new hole in finding 4 (a
// correct plan wrongly failing) alongside the one it closed.
const R1_SETUP = `## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
`;
const wrapR3 = (body: string) => `# Plan\n${CTX}\n${body}\n## Rollback\nRevert.\n`;
const r3Cases: Array<[string, boolean, string]> = [
  // Finding 2: same-release drop, various ORM phrasings. Each must still
  // fail even though the drop sentence also mentions the ORM.
  ["F2: 'Drop the column and remove it from the ORM model.' same release", false, wrapR3(`${R1_SETUP}## Release 3
5. Stop writing to the old full_name column.
6. Drop the column and remove it from the ORM model.
## Release 4
7. Drop the leftover index on the old column.`)],
  ["F2: 'Drop column full_name and remove it from the ORM.' same release", false, wrapR3(`${R1_SETUP}## Release 3
5. Stop writing to the old full_name column.
6. Drop column full_name and remove it from the ORM.
## Release 4
7. Drop the leftover index on the old column.`)],
  ["F2: 'Remove the full_name column from the database and the ORM model.' same release", false, wrapR3(`${R1_SETUP}## Release 3
5. Stop writing to the old full_name column.
6. Remove the full_name column from the database and the ORM model.
## Release 4
7. Drop the leftover index on the old column.`)],
  ["F2: bare 'model' term, 'remove it from the users model and drop the column' same release", false, wrapR3(`${R1_SETUP}## Release 3
5. Stop writing to the old full_name column, remove it from the users model and drop the column.
## Release 4
6. Drop the leftover index on the old column.`)],
  // Finding 3: a release-phase heading that happens to say "business
  // logic" / "data integrity rules" is never a preamble - its own step (an
  // early, wrong read switch) must still be read and still fail.
  ["F3: '## Release 2: business logic' heading hides early switch", false, wrapR3(`## Release 1: expand
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
## Release 2: business logic
3. Switch reads to first_name and last_name.
## Release 3: backfill
4. Backfill existing rows from full_name.
5. Confirm all reads use first_name and last_name.
## Release 4
6. Stop writing to the old full_name column.
## Release 5
7. Drop the old column full_name.`)],
  ["F3: '## Release 2: move business logic to the new columns' hides early switch", false, wrapR3(`## Release 1: expand
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
## Release 2: move business logic to the new columns
3. Switch reads to first_name and last_name.
## Release 3: backfill
4. Backfill existing rows from full_name.
5. Confirm all reads use first_name and last_name.
## Release 4
6. Stop writing to the old full_name column.
## Release 5
7. Drop the old column full_name.`)],
  ["F3: '## Release 2: read path and integrity rules' hides early switch", false, wrapR3(`## Release 1: expand
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
## Release 2: read path and integrity rules
3. Switch reads to first_name and last_name.
## Release 3: backfill
4. Backfill existing rows from full_name.
5. Confirm all reads use first_name and last_name.
## Release 4
6. Stop writing to the old full_name column.
## Release 5
7. Drop the old column full_name.`)],
  // Finding 6: object-first stopWrite forms need a negation guard and a
  // real object - neither of these describes an actual write cutover.
  ["F6: negated 'old writes are not removed yet' is not credited as stop-write", false, wrapR3(`${R1_SETUP}## Release 3
5. Monitor for a week; old writes are not removed yet.
## Release 4
6. Drop the old column full_name.`)],
  ["F6: 'write lock removed' is not credited as stop-write", false, wrapR3(`${R1_SETUP}## Release 3
5. Confirm the temporary write lock is removed from the users table.
## Release 4
6. Drop the old column full_name.`)],
  ["F6: negated 'write path is not exclusively first_name' is not credited", false, wrapR3(`${R1_SETUP}## Release 3
5. Keep the dual write: the write path is not exclusively first_name and last_name yet.
## Release 4
6. Drop the old column full_name.`)],
  // Minor: "together" must not cross a "parsed FROM full_name" source
  // reference to reach a write it never actually performs.
  ["minor: 'writes ... parsed from full_name, together' is not dual-write", false, wrapR3(`## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that writes first_name and last_name, parsed from full_name, together on every save.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop the old column full_name.`)],
  // Finding 4 (new hole introduced by round 2): a correct plan's dual-write
  // step must still pass when it mentions the old column as the read
  // source in a different clause, and a heading-style read-switch with the
  // verb after "read" must still be credited.
  ["F4: correct plan, 'Reads use full_name while first_name and last_name fill in' still passes", true, wrapR3(`## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns. Reads use full_name while first_name and last_name fill in.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop the old column full_name.`)],
  ["F4: correct plan, 'Read path switched to first_name' heading style still passes", true, wrapR3(`## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
3. Backfill existing rows from full_name.
## Release 2
4. Deploy with read path switched to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop the old column full_name.`)],
  // Finding 3 positive control: a genuine "## Business Logic" definitional
  // section (no release/phase word) must stay a preamble skip.
  ["F3: correct plan, '## Business Logic' definitional section still passes", true, `# Plan
## Business Logic
1. Split on the last space.
2. Single tokens go to first_name.
3. Empty strings stay null.
${wrapR3(R1_SETUP + `## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop the old column full_name.`)}`],
];
for (const [name, wantOk, text] of r3Cases) {
  const dir3 = mkdtempSync(join(tmpdir(), "plan-verify-r3-"));
  writeFileSync(join(dir3, "migration-plan.md"), text);
  const r = await verifyMigrationPlan(dir3);
  check(name, r.ok === wantOk, r.message);
  rmSync(dir3, { recursive: true, force: true });
}

// ---------- fix round 4: structural rewrite (controller ruling R13) ----------
// Round 3's narrowing still let fresh paraphrases through (findings 2, 3, 5,
// 6 of the round-3 re-review), and closing each with another keyword or gap
// tweak was a paraphrase hunt with no end. R13: implement the reviewer's
// structural rules instead - PREAMBLE by position (before the first
// release/phase/step-numbered heading, not by heading keyword), drop scoped
// to the column itself with a database-aware ORM reject, stop-write forms
// anchored to the real label/title shapes, dual-write "together" requiring
// fullname as an immediate write target. Every probe from t9r3/plan.ts.
const R1B = `## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
`;
const IDX_R4 = `## Release 4
7. Drop the leftover index on the old column.`;
const earlyR4 = (h: string) => wrapR3(`## Release 1: expand
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
${h}
3. Switch reads to first_name and last_name.
## Release 3: backfill
4. Backfill existing rows from full_name.
5. Confirm all reads use first_name and last_name.
## Release 4
6. Stop writing to the old full_name column.
## Release 5
7. Drop the old column full_name.`);
const noStopR4 = (s: string) => wrapR3(`${R1B}## Release 3
5. ${s}
## Release 4
6. Drop the old column full_name.`);
const sameRelR4 = (s: string) => wrapR3(`${R1B}## Release 3
5. Stop writing to the old full_name column.
6. ${s}
${IDX_R4}`);
const r4Cases: Array<[string, boolean, string]> = [
  ["F2 (r4): 'Drop the column from the ORM and the database.' same release", false, sameRelR4("Drop the column from the ORM and the database.")],
  ["F2 (r4): 'Delete the field from the ORM model and from Postgres.' same release", false, sameRelR4("Delete the field from the ORM model and from Postgres.")],
  ["F2 (r4): 'Drop the column from the ORM, then run ALTER TABLE...' same release", false, sameRelR4("Drop the column from the ORM, then run ALTER TABLE users DROP COLUMN full_name.")],
  ["F2 (r4): 'Remove the full_name column from the database and the ORM model.' same release", false, sameRelR4("Remove the full_name column from the database and the ORM model.")],
  ["F2 (r4): 'Drop the full_name column and remove it from the ORM model.' same release", false, sameRelR4("Drop the full_name column and remove it from the ORM model.")],
  ["F2 (r4): same-sentence 'stop writing full_name and delete the column'", false, wrapR3(`${R1B}## Release 3
5. Stop writing full_name and delete the column in the same deploy.
${IDX_R4}`)],
  ["F3 (r4): '## Business logic cutover' (no release word) hides early switch", false, earlyR4("## Business logic cutover")],
  ["F3 (r4): '## Cutover: naming rules applied to reads' hides early switch", false, earlyR4("## Cutover: naming rules applied to reads")],
  ["F3 (r4): '## Read-path business logic' hides early switch", false, earlyR4("## Read-path business logic")],
  ["F3 (r4): '## Switch reads (business logic)' hides early switch", false, earlyR4("## Switch reads (business logic)")],
  ["F3/R12 (r4) side effect: '## Invariants for every release' list is not parsed as steps", false, `# Plan
## Invariants for every release
1. Add columns as nullable before any code writes them.
2. Dual-write old and new columns until reads switch.
## Release 1
3. Add the new columns first_name and last_name as nullable.
4. Backfill existing rows from full_name.
## Release 2
5. Switch reads to first_name and last_name.
## Release 3
6. Stop writing to the old full_name column.
## Release 4
7. Drop the old column full_name.

## Rollback
Revert.
`],
  ["F6 (r4): forward ref 'Monitor error rates until old writes are removed.'", false, noStopR4("Monitor error rates until old writes are removed.")],
  ["F6 (r4): 'Plan a later release where writes are removed.'", false, noStopR4("Plan a later release where writes are removed.")],
  ["F6 (r4): 'Until the write path is exclusively first_name and last_name, keep dual writes.'", false, noStopR4("Until the write path is exclusively first_name and last_name, keep dual writes.")],
  ["F6 (r4): 'Do not ship Release 4 until old writes are removed.'", false, noStopR4("Do not ship Release 4 until old writes are removed.")],
  ["Minor-1 (r4): 'writes first_name and last_name, split out of full_name, together'", false, `# Plan
## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that writes first_name and last_name, split out of full_name, together on every save.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop the old column full_name.

## Rollback
Revert.
`],
  ["Minor-1 (r4): 'writes first_name and last_name based on full_name together'", false, `# Plan
## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that writes first_name and last_name based on full_name together in one transaction.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop the old column full_name.

## Rollback
Revert.
`],
  ["Minor-4 (r4) correct: 'Reads use full_name until first_name is backfilled' still passes", true, `# Plan
## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns. Reads use full_name until first_name is backfilled.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop the old column full_name.

## Rollback
Revert.
`],
  ["correct (r4): stop-write step also removes from ORM model still passes", true, wrapR3(`${R1B}## Release 3
5. Stop writing to the old full_name column and remove the column from the ORM model.
## Release 4
6. Drop the old column full_name.`)],
];
for (const [name, wantOk, text] of r4Cases) {
  const dir4 = mkdtempSync(join(tmpdir(), "plan-verify-r4-"));
  writeFileSync(join(dir4, "migration-plan.md"), text);
  const r = await verifyMigrationPlan(dir4);
  check(name, r.ok === wantOk, r.message);
  rmSync(dir4, { recursive: true, force: true });
}

// ---------- R12 coverage: the three round-1 (t9/b2.ts) probes never committed ----------
const dir5 = mkdtempSync(join(tmpdir(), "plan-verify-r1missing-"));
writeFileSync(join(dir5, "migration-plan.md"), `# Plan

## Steps
1. Add nullable users.first_name and users.last_name columns.
2. Deploy dual-write so both users.full_name and the new columns are written.
3. Switch reads to users.first_name and users.last_name.
4. Backfill existing rows.
5. Stop writing users.full_name.
6. In a later release, drop users.full_name.

## Rollback
Revert the release and keep the old column in place until the next deploy is safe.
`);
const r1MissingA = await verifyMigrationPlan(dir5);
check("R12 coverage: qualified_reads_before_backfill (t9/b2.ts)", !r1MissingA.ok, r1MissingA.message);

writeFileSync(join(dir5, "migration-plan.md"), `# Plan

## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column. Drop the full_name column and remove it from the ORM model.
## Release 4
6. Remove the dual-write helpers and drop the old column's index.

## Rollback
Revert the release and keep the old column in place until the next deploy is safe.
`);
const r1MissingB = await verifyMigrationPlan(dir5);
check("R12 coverage: orm_only_same_release (t9/b2.ts)", !r1MissingB.ok, r1MissingB.message);

writeFileSync(join(dir5, "migration-plan.md"), `# Plan

## Release 1
1. Add nullable first_name and last_name columns to users.
2. Update the profile service so it writes first_name and last_name together on every save, split from the submitted name.
3. Backfill existing rows from full_name in batches.
## Release 2
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing full_name.
## Release 4
6. Drop the full_name column.

## Rollback
Revert the release and keep the old column in place until the next deploy is safe.
`);
const r1MissingC = await verifyMigrationPlan(dir5);
check("R12 coverage: together_natural (t9/b2.ts)", !r1MissingC.ok, r1MissingC.message);
rmSync(dir5, { recursive: true, force: true });

process.exit(failed ? 1 : 0);
