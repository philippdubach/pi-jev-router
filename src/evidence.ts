/**
 * Aggregate recorded benchmark runs into per-model, per-work-kind statistics.
 *
 * This module reads files. `src/selector.ts` receives the result as an argument.
 * The `WorkKind` import must stay type-only. `src/selector.ts` imports `statsFor`
 * from here as a value, so a value import would create a runtime cycle.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkKind } from "./selector.ts";

export interface EvalRow {
  taskId: string;
  modelUsed: string;
  passed: boolean;
  costUsd: number;
  latencyMs: number;
  /** Verifier verdict before any turn budget. Older files omit it. */
  correct?: boolean;
  turns?: number;
  /** The runner's wall-clock cap fired. Older files omit it. */
  timedOut?: boolean;
}

/**
 * Whether a run that hit the wall-clock cap counts as a failure.
 *
 * Default true: a model that does not finish did not solve the task, and a
 * user waiting for the answer experiences it that way. Set false to score
 * correctness alone and let the latency axis carry the slowness. The two
 * views are kept comparable by recording the fact and applying it here.
 */
export const TIMEOUT_IS_FAILURE = true;

/**
 * Turns allowed before a run counts as a runaway loop.
 *
 * Applied when the evidence is read, not when it is recorded, so the threshold
 * can change without invalidating past runs. It sits well above the observed
 * median of six: at that value a single extra turn flipped a verdict, and 10
 * of 13 recorded failures were models that had solved the task correctly.
 * Efficiency is already carried by the cost axis, since more turns means more
 * tokens.
 */
export const TURN_BUDGET = 12;

/** Score one recorded run under the current budget. */
export function scoreRow(row: EvalRow, opts: { timeoutIsFailure?: boolean } = {}): boolean {
  const timeoutIsFailure = opts.timeoutIsFailure ?? TIMEOUT_IS_FAILURE;
  if (row.timedOut && timeoutIsFailure) return false;
  if (row.correct === undefined) return row.passed;
  if (!row.correct) return false;
  return row.turns === undefined || row.turns <= TURN_BUDGET;
}

export interface ModelStats {
  runs: number;
  passes: number;
  meanCostUsd: number;
  meanLatencyMs: number;
}

export type EvidenceIndex = Record<string, Partial<Record<WorkKind, ModelStats>>>;

/** Benchmark task ids are prefixed by work kind. */
export function workKindFromTaskId(taskId: string): WorkKind {
  const prefix = taskId.split("_")[0];
  if (prefix === "code") return "code";
  if (prefix === "plan") return "planning";
  if (prefix === "write") return "writing";
  return "other";
}

export function buildEvidence(rows: EvalRow[]): EvidenceIndex {
  const acc: Record<string, Partial<Record<WorkKind, { runs: number; passes: number; cost: number; latency: number }>>> = {};
  for (const row of rows) {
    if (!row || typeof row.modelUsed !== "string" || row.modelUsed.length === 0) continue;
    if (!Number.isFinite(row.costUsd) || !Number.isFinite(row.latencyMs)) continue;
    const kind = workKindFromTaskId(row.taskId ?? "");
    const byModel = (acc[row.modelUsed] ??= {});
    const cell = (byModel[kind] ??= { runs: 0, passes: 0, cost: 0, latency: 0 });
    cell.runs += 1;
    if (scoreRow(row)) cell.passes += 1;
    cell.cost += row.costUsd;
    cell.latency += row.latencyMs;
  }
  const out: EvidenceIndex = {};
  for (const [modelId, kinds] of Object.entries(acc)) {
    out[modelId] = {};
    for (const [kind, cell] of Object.entries(kinds) as [WorkKind, any][]) {
      out[modelId][kind] = {
        runs: cell.runs,
        passes: cell.passes,
        meanCostUsd: cell.cost / cell.runs,
        meanLatencyMs: cell.latency / cell.runs,
      };
    }
  }
  return out;
}

export function statsFor(
  evidence: EvidenceIndex,
  modelId: string,
  kind: WorkKind,
): ModelStats | undefined {
  return evidence[modelId]?.[kind];
}

/** Read every benchmark result file in `dir` and aggregate them. */
export function loadEvidence(dir = join(import.meta.dirname, "..", "eval", "results")): EvidenceIndex {
  const rows: EvalRow[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return {};
  }
  for (const name of names) {
    if (!name.startsWith("benchmark-") || !name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
      for (const r of parsed?.results ?? []) {
        rows.push({
          taskId: String(r.taskId ?? ""),
          modelUsed: String(r.modelUsed ?? ""),
          passed: Boolean(r.passed),
          costUsd: Number(r.costUsd),
          latencyMs: Number(r.latencyMs),
          correct: typeof r.correct === "boolean" ? r.correct : undefined,
          turns: Number.isFinite(r.turns) ? Number(r.turns) : undefined,
          timedOut: typeof r.timedOut === "boolean" ? r.timedOut : undefined,
        });
      }
    } catch {
      // A damaged result file must not break routing.
    }
  }
  return buildEvidence(rows);
}
