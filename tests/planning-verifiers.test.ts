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
rmSync(dir2, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
