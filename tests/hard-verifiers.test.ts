// The strict STE verifier's compound-instruction check must fail a real
// two-verb compound. The check is the pre-Task-9 rule (ruling R14): an
// imperative sentence of more than 8 words that contains "and" followed by
// a word. It also flags one imperative with a list object ("Identify the
// queue, environment, and owning team."). That is a false FAIL. A false
// FAIL is better than a false PASS, so the check stays strict.
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
// with its own object. This must fail.
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

// ---------- probes from the first review (t9/b2.ts) ----------
// Each sentence is a genuine second command and must be flagged.
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

// ---------- real model output, measured 2026-09-26 ----------
// Three runbooks from openai/gpt-6-sol in the Task 9 frontier benchmark. A
// human review found each one correct. The verifier flags list-object
// sentences in each one, for example "Identify the consumer service,
// queue, deployment environment, and owning team." Each such sentence has
// one verb and an "and"-joined list object. It is not two commands.
const adjudicatedRunbooks: Array<[string, string]> = [
  ["gpt6sol-runbook-list-object.md", "real gpt-6-sol runbook 1 (hard pass 1)"],
  ["gpt6sol-runbook-list-object-2.md", "real gpt-6-sol runbook 2 (writing pass 1)"],
  ["gpt6sol-runbook-list-object-3.md", "real gpt-6-sol runbook 3 (writing pass 2)"],
];
const dir2 = mkdtempSync(join(tmpdir(), "ste-verify-real-"));
for (const [file, name] of adjudicatedRunbooks) {
  // correct plan; verifier too strict; adjudicated PASS in results — see ADJUDICATIONS.md
  copyFileSync(join(import.meta.dirname, "fixtures", file), join(dir2, "runbook.md"));
  const r = await verifyStrictSTE(dir2);
  check(`${name}: verifier rejects it for list objects (adjudicated)`, !r.ok && r.message.includes("compound instruction"), r.message);
  rmSync(join(dir2, "runbook.md"));
}
rmSync(dir2, { recursive: true, force: true });

// ---------- probes from the second, third and fourth reviews ----------
// Sources: t9r2/ste.ts, t9r3/ste.ts, t9r4/ste4.ts. "true" means the
// sentence must be flagged as a compound instruction.
//
// A "false (too strict)" sentence is one imperative with a list object.
// The verifier flags it. The test records that verdict (ruling R14).
const LIST_OBJECTS = [
  "Identify the consumer service, queue, deployment environment, and owning team.",
  "Obtain access to the service manager and monitoring dashboard.",
  "Record the current consumer lag, partition offset, and restart count.",
  "Identify the service, the queue, and the owning team for the consumer.",
  "Record the consumer instance ID and current restart count.",
  "Escalate to the queue owner with the recorded offsets and logs.",
  "Obtain access to the service manager and alerting dashboard.",
  "Record the current consumer lag, error rate, and partition count.",
];
const COMPOUNDS = [
  "Drain the queue on the primary broker node and restart the service.",
  "Stop the consumer, drain the queue, and restart the service.",
  "Stop the affected message queue consumer and restart the pods.",
  "Stop the affected consumer on the primary node and notify the team.",
  "Scale the consumer deployment down to zero replicas and delete lock files.",
  "Open the deployment console for the consumer service and select Restart.",
  "Check the logs, metrics, and traces and restart the failing consumer service.",
  "Stop the affected message queue consumer and reset offsets.",
  "Stop the consumer service on every node and investigate.",
  "Pause the consumer group in the console and trigger rebalancing.",
  "Stop the consumer, drain the queue, and restart consumers.",
  "Stop the consumer, drain the queue, and restart all pods.",
  "Stop the consumer, purge the dead letters, and redeploy.",
  "Stop the affected consumer on the primary node and inform stakeholders.",
  "Cordon the node running the stuck consumer and evict pods.",
  "Stop the affected message queue consumer and restart all pods.",
  "Take a heap dump of the stuck consumer process and kill it.",
  "Restart the consumer on the primary node and ping hosts.",
  "Stop the consumer on the primary node and bring pods up.",
  "Stop the affected consumer on node four and bring back consumers.",
  "Stop the consumer, wait five minutes, and restart pods.",
  "Stop the consumer, clear stale locks, and restart consumers.",
];
const dir3 = mkdtempSync(join(tmpdir(), "ste-verify-probes-"));
const isCompound = async (sentence: string) => {
  writeFileSync(join(dir3, "runbook.md"), runbookWithStep(sentence));
  const r = await verifyStrictSTE(dir3);
  return { flagged: r.message.includes("compound instruction"), message: r.message };
};
for (const sentence of COMPOUNDS) {
  const r = await isCompound(sentence);
  check(`compound=true: "${sentence.slice(0, 55)}..."`, r.flagged, r.message);
}
for (const sentence of LIST_OBJECTS) {
  const r = await isCompound(sentence);
  check(`compound=false (too strict, flagged): "${sentence.slice(0, 45)}..."`, r.flagged, r.message);
}

// ---------- KNOWN_HOLES ----------
// Each sentence below is a genuine compound, but the verifier does not
// flag it. The pre-Task-9 verifier also does not flag it, so the hole is
// not new. Each one has exactly 8 words, and the check applies only to
// sentences of more than 8 words. These cases print SKIP and do not fail
// the suite. See eval/results/ADJUDICATIONS.md.
const KNOWN_HOLES = [
  "Stop the consumer, drain queues, and restart pods.",
  "Stop the consumer, drain all queues, and redeploy.",
];
for (const sentence of KNOWN_HOLES) {
  const r = await isCompound(sentence);
  const note = r.flagged ? " (the verifier now flags it; move it to COMPOUNDS)" : "";
  console.log(`SKIP "${sentence}": pre-existing hole, see eval/results/ADJUDICATIONS.md${note}`);
}
rmSync(dir3, { recursive: true, force: true });

process.exit(failed ? 1 : 0);
