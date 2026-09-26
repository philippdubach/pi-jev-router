// Evidence aggregation — run: node --experimental-strip-types tests/evidence.test.ts
import { buildEvidence, workKindFromTaskId, statsFor, TASK_TIER, type EvalRow } from "../src/evidence.ts";
import { BENCHMARK_TASKS } from "../eval/tasks.ts";
import { HARD_TASKS } from "../eval/hard-tasks.ts";
import { CEILING_TASKS } from "../eval/ceiling-tasks.ts";
import { PLANNING_TASKS } from "../eval/planning-tasks.ts";

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


// --- timeouts scored at read time ---
import { scoreRow } from "../src/evidence.ts";
const timedOutRow: any = { taskId: "code_x", modelUsed: "m", passed: false, costUsd: 0.01, latencyMs: 180000, correct: true, turns: 3, timedOut: true };
check("timeout fails by default", scoreRow(timedOutRow) === false);
check("timeout can be scored on correctness alone", scoreRow(timedOutRow, { timeoutIsFailure: false }) === true);
const cleanRow: any = { ...timedOutRow, timedOut: false, latencyMs: 20000 };
check("a finished correct run passes either way", scoreRow(cleanRow) && scoreRow(cleanRow, { timeoutIsFailure: false }));
const wrongTimedOut: any = { ...timedOutRow, correct: false };
check("a wrong timed-out run fails either way", !scoreRow(wrongTimedOut) && !scoreRow(wrongTimedOut, { timeoutIsFailure: false }));

// --- hard-task tier and hard-cell evidence ---
for (const t of [...BENCHMARK_TASKS, ...HARD_TASKS, ...CEILING_TASKS, ...PLANNING_TASKS]) {
  check(`tier known: ${t.id}`, TASK_TIER[t.id] === "base" || TASK_TIER[t.id] === "hard");
}
const tierRow = (taskId: string, passed: boolean) => ({ taskId, modelUsed: "m/x", passed, costUsd: 0.01, latencyMs: 1000 });
const tierEv = buildEvidence([tierRow("code_lru_ttl", true), tierRow("code_lru_ttl", true), tierRow("code_distant_cause", false), tierRow("code_thread_field", true)]);
check("overall cell counts all runs", statsFor(tierEv, "m/x", "code")?.runs === 4);
check("hard cell counts hard runs", statsFor(tierEv, "m/x", "code")?.hard?.runs === 2 && statsFor(tierEv, "m/x", "code")?.hard?.passes === 1);
check("hard lookup returns the hard cell", statsFor(tierEv, "m/x", "code", { hard: true })?.runs === 2);
const thin = buildEvidence([tierRow("code_lru_ttl", true), tierRow("code_distant_cause", false)]);
check("one hard run falls back to overall", statsFor(thin, "m/x", "code", { hard: true })?.runs === 2);

process.exit(failed ? 1 : 0);
