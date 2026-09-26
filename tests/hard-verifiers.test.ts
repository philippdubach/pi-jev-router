// The strict STE verifier's compound-instruction check must fail a real
// two-verb compound and pass a single imperative with a plain list object.
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyStrictSTE } from "../eval/hard-verifiers.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(cond ? "PASS" : "FAIL", name, cond ? "" : detail);
  if (!cond) failed++;
}
const dir = mkdtempSync(join(tmpdir(), "ste-verify-"));
const put = (name: string, text: string) => writeFileSync(join(dir, name), text);

check("empty state fails", !(await verifyStrictSTE(dir)).ok);

// A genuine compound instruction: two imperatives joined by "and", each
// with its own determiner-led object. This must still fail.
put("runbook.md", `# Restart a stuck consumer

## Purpose

Restore message processing for a consumer that stopped making progress.

## Preconditions

- Confirm the consumer lag is increasing.
- Obtain access to the deployment console.

## Steps

1. Stop the affected message queue consumer and restart the failing service immediately.
2. Notify the on-call engineering team and escalate the incident to management.
3. Confirm the consumer resumes processing.

## Verification

- Confirm the consumer offset advances.

## Rollback

- Restore the previous replica count if needed.
`);
const compound = await verifyStrictSTE(dir);
check("a real compound instruction still fails", !compound.ok, compound.message);
check("names the compound instruction", compound.message.includes("compound instruction"), compound.message);

rmSync(join(dir, "runbook.md"));

// ---------- fix round 2: negative controls for the narrowed compound check ----------
// The determiner-requiring fix from round 1 ("and restart THE service")
// rejected 6 of 7 real compound sentences a code review found, including
// the code's own worked example ("Stop the consumer and restart it.").
// Each sentence below is a genuine second command and must still fail,
// however its object is phrased.
const runbookWithStep = (sentence: string) => `# Restart a stuck consumer

## Purpose

Restore message processing for a consumer that stopped making progress.

## Preconditions

- Confirm the consumer lag is increasing.
- Obtain access to the deployment console.

## Steps

1. ${sentence}
2. Confirm the consumer resumes processing.
3. Record the restart time.

## Verification

- Confirm the consumer offset advances.

## Rollback

- Restore the previous replica count if needed.
`;
const stillCompound = [
  "Stop the affected message queue consumer and then restart the failing service.",
  "Stop the affected message queue consumer service and restart it on the same node.",
  "Stop the affected message queue consumer and wait for the pending messages to drain.",
  "Stop the affected message queue consumer and restart all consumer pods in the namespace.",
  "Stop the affected message queue consumer and restart consumers in the secondary region.",
  "Scale the consumer deployment to zero replicas and delete stale lock files from disk.",
];
for (const sentence of stillCompound) {
  put("runbook.md", runbookWithStep(sentence));
  const r = await verifyStrictSTE(dir);
  check(`still flags: "${sentence.slice(0, 60)}..."`, !r.ok && r.message.includes("compound instruction"), r.message);
  rmSync(join(dir, "runbook.md"));
}

rmSync(dir, { recursive: true, force: true });

// ---------- real model output as positive control ----------
// Produced by openai/gpt-6-sol in the Task 9 frontier benchmark
// (2026-09-26). The first pass of this run's verifier rejected it for "2
// compound instruction(s)": "Identify the consumer service, queue,
// deployment environment, and owning team." and "Obtain access to the
// service manager and monitoring dashboard." Neither is two imperatives;
// each is one imperative with an "and"-joined list object. The verifier's
// compound check matched any sentence containing "and", with no way to
// tell a list from a second command.
const dir2 = mkdtempSync(join(tmpdir(), "ste-verify-real-"));
copyFileSync(join(import.meta.dirname, "fixtures", "gpt6sol-runbook-list-object.md"), join(dir2, "runbook.md"));
const real = await verifyStrictSTE(dir2);
check("real gpt-6-sol runbook (list object, not compound) passes", real.ok, real.message);
rmSync(dir2, { recursive: true, force: true });

process.exit(failed ? 1 : 0);
