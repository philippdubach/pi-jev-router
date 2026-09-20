/**
 * Task envelope + classification contract (M1).
 *
 * Jev classifies what a task needs; it never computes costs, counts or
 * model eligibility. Those come from local deterministic code.
 */

export type Role = "direct" | "coordinator" | "scout" | "implementer" | "reviewer";

export interface TaskFacts {
  language?: string;
  hasImages: boolean;
  estimatedContextTokens: number;
  requiredTools: string[];
  attempt: number;
  priorFailureKinds: string[];
}

export interface TaskEnvelope {
  taskId: string;
  parentTaskId?: string;
  role: Role;
  objective: string;
  acceptanceCriteria: string[];
  relevantContext: string;
  facts: TaskFacts;
  policyRef: string;
}

export type JevPrimitive = "noul" | "choice" | "score";

export interface JevAnswer {
  id: string;
  type: JevPrimitive;
  /** choice key / score expectation / noul probability */
  value: string | number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface ClassificationResult {
  answers: Record<string, JevAnswer>;
  requestedModel: string;
  resolvedModel: string;
  provider?: string;
  requestId?: string;
  usage?: { inputTokens: number; outputTokens: number; cost?: number };
  latencyMs: number;
  ok: boolean;
  error?: string;
  /** API unavailable — caller must use static fallback policy */
  classifierUnavailable?: boolean;
}

export const CLASSIFIER_TIMEOUT_MS = 1500;
export const CLASSIFIER_MODEL = "typesafe/jev-1.13";