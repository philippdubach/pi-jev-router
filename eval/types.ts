export type BenchmarkTaskKind = "code" | "planning" | "writing";

export interface BenchmarkTask {
  id: string;
  name: string;
  kind: BenchmarkTaskKind;
  prompt: string;
  setupFiles?: Record<string, string>;
  verifierCommand?: string;
  customVerifier?: (workspaceDir: string) => Promise<{ ok: boolean; message: string }>;
  /**
   * Turns allowed before a run counts as a runaway loop.
   *
   * This is a safety rail, not an efficiency ranking. An earlier version set it
   * at six, which was the median of the observed distribution, so a single
   * extra turn flipped a verdict and 10 of 13 recorded failures were models
   * that had solved the task correctly. Efficiency is already priced into the
   * cost axis, because more turns means more tokens; scoring it again as a
   * quality failure double-counts it and adds noise.
   */
  maxTurns?: number;
}

/** `model:<id>` pins a single model, for measuring it directly. */
export type RoutingStrategy = "fixed_frontier" | "router_role" | "router_frontier" | `model:${string}`;

export interface TaskRunResult {
  taskId: string;
  strategy: RoutingStrategy;
  modelUsed: string;
  thinkingUsed: string;
  /** Verifier verdict alone, independent of any turn budget. */
  correct: boolean;
  /** `correct` after the budget is applied. Kept for reports. */
  passed: boolean;
  /** The wall-clock cap fired. Recorded on its own so read-time scoring can decide what it means. */
  timedOut?: boolean;
  verifierOutput: string;
  latencyMs: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  costUsd: number;
  turns: number;
  error?: string;
}

export interface StrategySummary {
  strategy: RoutingStrategy;
  totalTasks: number;
  passedTasks: number;
  passRate: number;
  totalCostUsd: number;
  costPerSuccessUsd: number;
  avgLatencyMs: number;
  totalTokens: number;
}
