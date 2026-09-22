export type BenchmarkTaskKind = "code" | "planning" | "writing";

export interface BenchmarkTask {
  id: string;
  name: string;
  kind: BenchmarkTaskKind;
  prompt: string;
  setupFiles?: Record<string, string>;
  verifierCommand?: string;
  customVerifier?: (workspaceDir: string) => Promise<{ ok: boolean; message: string }>;
}

/** `model:<id>` pins a single model, for measuring it directly. */
export type RoutingStrategy = "fixed_frontier" | "router_role" | "router_frontier" | `model:${string}`;

export interface TaskRunResult {
  taskId: string;
  strategy: RoutingStrategy;
  modelUsed: string;
  thinkingUsed: string;
  passed: boolean;
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
