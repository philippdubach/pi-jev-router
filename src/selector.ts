/**
 * Deterministic tier policy (M1 shadow mode).
 *
 * Maps Jev classification answers to a recommended OpenRouter model tier.
 * No cost math, no Jev arithmetic — pure local policy on bounded inputs.
 */

export interface Policy {
  version: 1;
  allowlist: string[]; // concrete OpenRouter model IDs, ordered cheap -> strong
  tierMapping: {
    // complexity score expectation (0..3) -> index into allowlist
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  riskFloor: {
    // risk >= 2 forces at least this allowlist index
    minIndex: number;
  };
  fallbackModelId: string;
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  // 0: cheap/fast   1: mid coder   2: strong coder
  // Pruned to models verified present in the OpenRouter catalog on 2026-09-20.
  allowlist: [
    "google/gemini-3.8-flash",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-fable-5.1",
  ],
  tierMapping: { low: 0, medium: 1, high: 2, critical: 2 },
  riskFloor: { minIndex: 1 },
  fallbackModelId: "anthropic/claude-fable-5.1",
};

export type RecommendationReason =
  | "tier_by_complexity"
  | "risk_floor"
  | "fallback"
  | "classifier_unavailable";

export interface Recommendation {
  modelId: string;
  tierIndex: number;
  reason: RecommendationReason;
  complexity?: number;
  risk?: number;
  confidence?: number;
}

export function recommend(
  answers: Record<string, { type: string; value: string | number; confidence?: number }>,
  policy: Policy,
  classifierAvailable: boolean,
): Recommendation {
  if (!classifierAvailable) {
    const idx = policy.allowlist.indexOf(policy.fallbackModelId);
    return {
      modelId: policy.fallbackModelId,
      tierIndex: idx >= 0 ? idx : policy.allowlist.length - 1,
      reason: "fallback",
    };
  }
  const complexity = typeof answers.complexity?.value === "number" ? answers.complexity.value : 1;
  const risk = typeof answers.risk?.value === "number" ? answers.risk.value : 1;
  const confidence = typeof answers.complexity?.confidence === "number" ? answers.complexity.confidence : undefined;

  const tier =
    complexity < 0.75 ? policy.tierMapping.low
    : complexity < 1.75 ? policy.tierMapping.medium
    : complexity < 2.25 ? policy.tierMapping.high
    : policy.tierMapping.critical;

  const idx = Math.min(
    policy.allowlist.length - 1,
    Math.max(tier, risk >= 2 ? policy.riskFloor.minIndex : 0),
  );

  const reason: RecommendationReason =
    risk >= 2 && idx === policy.riskFloor.minIndex && idx > tier ? "risk_floor" : "tier_by_complexity";

  return { modelId: policy.allowlist[idx], tierIndex: idx, reason, complexity, risk, confidence };
}