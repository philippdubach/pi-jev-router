// Evidence aggregation — run: node --experimental-strip-types tests/evidence.test.ts
import { buildEvidence, workKindFromTaskId, statsFor, type EvalRow } from "../src/evidence.ts";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(ok ? "PASS" : "FAIL", name);
  if (!ok) failed++;
};

check("code prefix", workKindFromTaskId("code_lru_ttl") === "code");
check("plan prefix", workKindFromTaskId("plan_distributed_ratelimiter") === "planning");
check("write prefix", workKindFromTaskId("write_incident_postmortem") === "writing");
check("unknown prefix", workKindFromTaskId("weird_task") === "other");

const rows: EvalRow[] = [
  { taskId: "code_lru_ttl", modelUsed: "m/a", passed: true, costUsd: 0.10, latencyMs: 1000 },
  { taskId: "code_semver_sort", modelUsed: "m/a", passed: true, costUsd: 0.20, latencyMs: 3000 },
  { taskId: "code_retry_queue", modelUsed: "m/a", passed: false, costUsd: 0.30, latencyMs: 2000 },
  { taskId: "plan_x", modelUsed: "m/a", passed: true, costUsd: 1.00, latencyMs: 9000 },
  { taskId: "code_lru_ttl", modelUsed: "m/b", passed: true, costUsd: 0.05, latencyMs: 500 },
];

const ev = buildEvidence(rows);
const a = statsFor(ev, "m/a", "code")!;
check("counts runs", a.runs === 3);
check("counts passes", a.passes === 2);
check("means cost", Math.abs(a.meanCostUsd - 0.2) < 1e-9);
check("means latency", a.meanLatencyMs === 2000);

const aPlan = statsFor(ev, "m/a", "planning")!;
check("separates work kinds", aPlan.runs === 1 && aPlan.meanCostUsd === 1.0);

check("unknown model", statsFor(ev, "m/zzz", "code") === undefined);
check("unknown kind for known model", statsFor(ev, "m/b", "writing") === undefined);

const bad = buildEvidence([
  { taskId: "code_x", modelUsed: "", passed: true, costUsd: 1, latencyMs: 1 },
  { taskId: "code_y", modelUsed: "m/c", passed: true, costUsd: Number.NaN, latencyMs: 1 },
] as EvalRow[]);
check("drops rows with no model", statsFor(bad, "", "code") === undefined);
check("drops rows with non-finite cost", statsFor(bad, "m/c", "code") === undefined);

process.exit(failed ? 1 : 0);
