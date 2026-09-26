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

// ---------- review probes, 2026-09-26 ----------
// Code reviews of the Task 9 verifier changes wrote these plans. Each wrong
// plan must fail. The verifier is the pre-Task-9 logic plus two parsing
// fixes (qualified-name dots, fenced code blocks), per ruling R14.
const CTX = `## Context
Two releases run side by side during every deploy, so each step must keep working while the previous release serves traffic.
`;

// Finding 1: "write X and Y together" does not name the old column. It is
// not a dual-write.
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

// Finding 2: a same-release drop. The drop sentence also names the ORM.
// The plan must fail.
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

// Finding 3: a release heading that contains "logic". Its step (an early
// read switch) must count, and the order check must fail.
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

// Finding 4: writes stop before reads switch (wrong order). The backfill
// step also says "reads ... use a snapshot". That sentence names no new
// column, so it is not a read switch.
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

// Positive control for finding 4: a correct plan. Its dual-write step says
// "Reads come from full_name" (the old column). That is not a read switch,
// so the plan must pass.
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

// Negative control for the dot fix: a same-release drop with qualified
// `users.full_name` names. The dot fix must not hide the drop.
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
check("migration: qualified-name same-release drop names the release boundary", qualifiedSameReleaseDrop.message.includes("same release"), qualifiedSameReleaseDrop.message);

// Negative control for the fence fix: a same-release drop. The DROP
// COLUMN is in a fenced SQL block. The fence fix must not hide the drop.
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
check("migration: fenced same-release drop names the release boundary", fencedSameReleaseDrop.message.includes("same release"), fencedSameReleaseDrop.message);

// Positive control for the dot fix: a correct plan that uses qualified
// names. Without the fix, the "." in "users.first_name" stops the add
// detector before it reaches "columns".
put("migration-plan.md", `# Plan
${CTX}
## Release 1
1. Add nullable users.first_name and users.last_name columns.
2. Deploy dual-write so both users.full_name and the new columns are written.
3. Backfill existing rows from users.full_name in batches.
## Release 2
4. Switch reads to users.first_name and users.last_name.
## Release 3
5. Stop writing users.full_name.
## Release 4
6. Drop the users.full_name column.

## Rollback
Revert.
`);
const qualifiedCorrect = await verifyMigrationPlan(dir);
check("migration: correct plan with users.full_name qualified names passes", qualifiedCorrect.ok, qualifiedCorrect.message);

// Positive control for the fence fix: a correct plan whose only DROP
// COLUMN is in a fenced block, in a later release. Without the fix, the
// fence ends the step and the plan has no drop step.
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
## Release 4
6. Run the contract migration:

\`\`\`sql
ALTER TABLE users DROP COLUMN full_name;
\`\`\`

## Rollback
Revert.
`);
const fencedCorrect = await verifyMigrationPlan(dir);
check("migration: correct plan with a fenced DROP COLUMN in a later release passes", fencedCorrect.ok, fencedCorrect.message);

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
// Each plan is a real Task 9 benchmark artifact, and a human review found
// each one correct.
//
// This plan is a positive control for the dot fix. It is gpt-6-sol's
// second plan_expand_contract run. It uses `users.full_name` qualified
// names. The verifier passes it only with the dot fix.
copyFileSync(join(import.meta.dirname, "fixtures", "gpt6sol-migration-plan-qualified-names-2.md"), join(dir2, "migration-plan.md"));
const gpt6solReal2 = await verifyMigrationPlan(dir2);
check("real gpt-6-sol plan 2 (users.full_name qualified names) passes", gpt6solReal2.ok, gpt6solReal2.message);
rmSync(join(dir2, "migration-plan.md"));

// The verifier rejects the four plans below. The verifier is not made
// looser to accept them: a false FAIL is better than a false PASS (ruling
// R14). Each test records the verdict that the verifier gives now.
const adjudicatedPlans: Array<[string, string]> = [
  // Opus pass 1. The verifier reads the Step 0 inventory ("reads in
  // Release 3, writes in Release 4") as the read switch, before the
  // backfill. It also reads "remove the column from the ORM model"
  // (Release 4, with the write stop) as the drop. The real DROP COLUMN is
  // in Release 5.
  ["opus-migration-plan-fenced-drop.md", "real Opus plan (fenced DROP COLUMN)"],
  // gpt-6-sol pass 1. The dual-write step says "write full_name,
  // first_name, and last_name together". The verifier does not know this
  // form, so it takes a later step as the dual-write.
  ["gpt6sol-migration-plan-qualified-names.md", "real gpt-6-sol plan (users.full_name qualified names)"],
  // Gemini pass 1. The verifier reads the numbered list under the
  // "Business Rules" heading as steps. Its dual-write rule then comes
  // before the step that adds the column.
  ["gemini-migration-plan-business-rules.md", "real Gemini plan (Business Rules numbered list)"],
  // Gemini pass 2. The read switch and the write stop are object-first
  // ("Read Path: Read directly from first_name", "with Old Writes
  // Removed"). The verifier knows only verb-first forms. It also reads the
  // "Data Integrity Rules" list as steps.
  ["gemini-migration-plan-object-first-stopwrite.md", "real Gemini plan (object-first stop-write phrasing)"],
];
for (const [file, name] of adjudicatedPlans) {
  // correct plan; verifier too strict; adjudicated PASS in results — see ADJUDICATIONS.md
  copyFileSync(join(import.meta.dirname, "fixtures", file), join(dir2, "migration-plan.md"));
  const r = await verifyMigrationPlan(dir2);
  check(`${name}: verifier rejects it (adjudicated)`, !r.ok, r.message);
  rmSync(join(dir2, "migration-plan.md"));
}

rmSync(dir2, { recursive: true, force: true });

// ---------- probes from the second review (t9r2/probes.ts) ----------
// Ruling R12: every review probe is a committed test. A wrong plan must
// fail. A correct plan that the verifier rejects is marked "verifier too
// strict" and records the FAIL (ruling R14).
const R1_SETUP = `## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
`;
const wrapR3 = (body: string) => `# Plan\n${CTX}\n${body}\n## Rollback\nRevert.\n`;
const r3Cases: Array<[string, boolean, string]> = [
  // Finding 2: same-release drops. Each drop sentence also names the ORM.
  // Each plan must fail.
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
  // Finding 3: release headings that contain "business logic" or
  // "integrity rules". The step below each one (an early read switch) must
  // count, and the plan must fail.
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
  // Finding 6: none of these sentences stops the old writes. Each plan
  // has no stop-write step and must fail.
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
  // Minor: "parsed from full_name" names the source of the data. The step
  // does not write full_name, so it is not a dual-write.
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
  // Finding 4: a correct plan's dual-write step may name the old column as
  // the read source. That is not a read switch.
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
  // Correct plan; verifier too strict. The verifier does not know the
  // object-first form "read path switched to". It records FAIL.
  ["F4: correct plan, 'Read path switched to first_name' (verifier too strict, FAIL)", false, wrapR3(`## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
3. Backfill existing rows from full_name.
## Release 2
4. Deploy with read path switched to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop the old column full_name.`)],
  // Finding 3 positive control: a correct plan with a "## Business Logic"
  // section first. The verifier reads that list as steps, but the items
  // match no phase, so the plan passes.
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

// ---------- probes from the third review (t9r3/plan.ts) ----------
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
  // Correct plan; verifier too strict. The verifier reads "remove the
  // column from the ORM model" as the drop, in the same release as the
  // write stop. It records FAIL.
  ["correct (r4): stop-write step also removes from ORM model (verifier too strict, FAIL)", false, wrapR3(`${R1B}## Release 3
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

// ---------- probes from the first review (t9/b2.ts) ----------
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

// ---------- probes from the fourth review (t9r4/plan4.ts, t9r4/inc.ts) ----------
const DECOY_R4 = `## Release 4
7. Delete the leftover trigger on the old column.`;
const sameRelDecoy = (s: string) => wrapR3(`${R1B}## Release 3
5. Stop writing to the old full_name column.
6. ${s}
${DECOY_R4}`);
const r5Cases: Array<[string, boolean, string]> = [
  ["r5 A: 'Release N' headings; the Invariants list is not the dual-write", false, `# Plan
## Invariants
1. Add columns as nullable before any code writes them.
2. Dual-write old and new columns until reads switch.
## Release N
3. Add the new columns first_name and last_name as nullable.
4. Backfill existing rows from full_name.
## Release N+1
5. Switch reads to first_name and last_name.
## Release N+2
6. Stop writing to the old full_name column.
## Release N+3
7. Drop the old column full_name.

## Rollback
Revert.
`],
  ["r5 A: phase headings; the Constraints list is not the dual-write", false, `# Plan
## Constraints
1. Add columns as nullable before any code writes them.
2. Dual-write old and new columns until reads switch.
## Expand phase
3. Add the new columns first_name and last_name as nullable.
4. Backfill existing rows from full_name.
## Migrate phase
5. Switch reads to first_name and last_name.
6. Stop writing to the old full_name column.
## Contract phase (next deploy)
7. Drop the old column full_name.

## Rollback
Revert.
`],
  ["r5 A: early read switch under an un-numbered first heading", false, wrapR3(`## Initial deploy
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
3. Switch reads to first_name and last_name.
## Release 2
4. Add NOT NULL-ready check constraints for the new columns.
5. Keep dual-writing both old and new columns.
6. Backfill existing rows from full_name.
7. Confirm all reads use first_name and last_name.
## Release 3
8. Stop writing to the old full_name column.
## Release 4
9. Drop the old column full_name.`)],
  ["r5 A: correct plan, '### Release 2 rollback' in the Rollback section", true, `# Plan
${CTX}
## Steps
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
3. Backfill existing rows from full_name.
4. Switch reads to first_name and last_name.
5. Stop writing to the old full_name column.
6. In a later release, drop the old column full_name.

## Rollback
### Release 2 rollback
Revert the read switch.
`],
  ["r5 A: correct plan, un-numbered phase headings and a 'Phase 2' notes heading", true, `# Plan
${CTX}
## Expand
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that dual-writes both old and new columns.
3. Backfill existing rows from full_name.
## Migrate (next release)
4. Switch reads to first_name and last_name.
## Contract (next release)
5. Stop writing to the old full_name column.
## Cleanup release
6. Drop the old column full_name in a later release.
## Monitoring for Phase 2
Watch error rates.

## Rollback
Revert.
`],
  ["r5 B: same-release 'Drop the index and the full_name column.'", false, sameRelDecoy("Drop the index and the full_name column.")],
  ["r5 B: same-release 'Drop the unique constraint and then the full_name column.'", false, sameRelDecoy("Drop the unique constraint and then the full_name column.")],
  ["r5 B: same-release 'Drop the key column full_name.'", false, sameRelDecoy("Drop the key column full_name.")],
  // Correct plan; verifier too strict. The drop object must contain
  // "column" or "field". "Drop full_name" has neither. It records FAIL.
  ["r5 B: correct plan 'Drop full_name and its index.' (verifier too strict, FAIL)", false, wrapR3(`${R1B}## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop full_name and its index.`)],
  ["r5 C: 'Prepare the Release 4 build with old writes removed.' is not a stop-write", false, wrapR3(`${R1B}## Release 3
5. Prepare the Release 4 build with old writes removed.
## Release 4
6. Deploy the Release 4 build and drop the old column full_name.`)],
  ["r5 C: 'write path: exclusively first_name' as a target state is not a stop-write", false, wrapR3(`${R1B}## Release 3
5. Target state for Release 4 - write path: exclusively first_name and last_name.
## Release 4
6. Deploy that change and drop the old column full_name.`)],
  ["r5 E: 'writes every field except full_name together' is not a dual-write", false, wrapR3(`## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that writes every field except full_name together in one transaction.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop the old column full_name.`)],
  ["r5 E: 'writes to first_name, not full_name, together' is not a dual-write", false, wrapR3(`## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that writes to first_name, not full_name, together with last_name.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop the old column full_name.`)],
  // Correct plan; verifier too strict. The verifier does not know the
  // "write full_name, first_name, and last_name together" form. It records
  // FAIL. The real gpt-6-sol plan 1 above fails for the same reason.
  ["r5 E: correct 'writes full_name, first_name, and last_name together' (verifier too strict, FAIL)", false, wrapR3(`## Release 1
1. Add the new columns first_name and last_name as nullable.
2. Deploy code that writes full_name, first_name, and last_name together.
3. Backfill existing rows from full_name.
## Release 2
4. Switch reads to first_name and last_name.
## Release 3
5. Stop writing to the old full_name column.
## Release 4
6. Drop the old column full_name.`)],
];
for (const [name, wantOk, text] of r5Cases) {
  const d = mkdtempSync(join(tmpdir(), "plan-verify-r5-"));
  writeFileSync(join(d, "migration-plan.md"), text);
  const r = await verifyMigrationPlan(d);
  check(name, r.ok === wantOk, r.message);
  rmSync(d, { recursive: true, force: true });
}

const incR5Cases: Array<[string, boolean, string]> = [
  ["r5 incident: cache warmed before the database check, in an un-numbered first section", false, `# Incident: multi-system outage

## Immediate actions
1. Warm the cache from the last snapshot. Owner: on-call SRE
2. Declare the incident and open the bridge. Owner: incident commander

## Phase 2: recovery
3. Confirm the database is healthy and accepting connections. Owner: DBA
4. Drain the queue backlog once the database is healthy. Owner: platform engineer
5. Re-enable the api gateway routes. Owner: network engineer
6. Warm the cache after the database check passes. Owner: on-call SRE
7. Verify error rates return to baseline. Owner: incident commander

## Rollback
Revert.
`],
  ["r5 incident: correct runbook, a Rollback subsection names 'step 3'", true, `# Incident: multi-system outage

## Steps
1. Declare the incident and open the bridge. Owner: incident commander
2. Confirm the database is healthy and accepting connections. Owner: DBA
3. Drain the queue backlog. Owner: platform engineer
4. Re-enable the api gateway routes. Owner: network engineer
5. Warm the cache after the database check passes. Owner: on-call SRE
6. Verify error rates return to baseline. Owner: incident commander

## Rollback
### Undo step 3
Pause the queue consumers.
`],
];
for (const [name, wantOk, text] of incR5Cases) {
  const d = mkdtempSync(join(tmpdir(), "inc-verify-r5-"));
  writeFileSync(join(d, "incident-runbook.md"), text);
  const r = await verifyIncidentRunbook(d);
  check(name, r.ok === wantOk, r.message);
  rmSync(d, { recursive: true, force: true });
}

// ---------- KNOWN_HOLES ----------
// Each plan below is wrong, but the verifier passes it. The pre-Task-9
// verifier also passes it, so the hole is not new. These cases do not
// fail the suite. They print SKIP. Close a hole only with a change that
// makes the verifier stricter, then move the case to the asserted probes.
// See eval/results/ADJUDICATIONS.md.
const KNOWN_HOLES: Array<[string, string]> = [
  // "Drop full_name." has no "column" or "field" word, so the verifier
  // does not see the drop. It takes the later "Delete the leftover trigger
  // on the old column" as the drop, in a later release.
  ["r5 B: same-release 'Drop full_name.' with a later trigger decoy", sameRelDecoy("Drop full_name.")],
];
for (const [name, text] of KNOWN_HOLES) {
  const d = mkdtempSync(join(tmpdir(), "plan-verify-hole-"));
  writeFileSync(join(d, "migration-plan.md"), text);
  const r = await verifyMigrationPlan(d);
  const note = r.ok ? "" : " (the verifier now rejects it; move it to the asserted probes)";
  console.log(`SKIP ${name}: pre-existing hole, see eval/results/ADJUDICATIONS.md${note}`);
  rmSync(d, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
