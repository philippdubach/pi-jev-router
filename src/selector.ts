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
  | "classifier_unavailable"
  | "role_policy";

/** Work kinds drive role-based model selection. */
export type WorkKind = "planning" | "code" | "writing" | "other";

/**
 * Role-based routing (user directive):
 * - planning/coordinator  -> frontier intelligence (superior planning)
 * - code implementation / PR review -> expert Pareto coding agent
 * - prose / writing       -> frontier FAST OpenAI models (user prefers style)
 */
/** Routing profile:
 * - "pareto_code": user directive (openrouter/pareto-code for coding tasks)
 * - "empirical_cost": benchmark-optimized Pareto frontier (claude-sonnet-5 for code, giving 88% cost savings with identical 100% pass rate)
 */
export type RouterProfile = "pareto_code" | "empirical_cost";

export const PROFILE_MODELS: Record<RouterProfile, Record<WorkKind, string>> = {
  pareto_code: {
    planning: "anthropic/claude-sonnet-5",
    code: "openrouter/pareto-code",
    writing: "openai/gpt-5.4-mini",
    other: "",
  },
  empirical_cost: {
    planning: "anthropic/claude-sonnet-5",
    code: "anthropic/claude-sonnet-5", // benchmark proven: 88% cheaper than pareto-code with identical 100% pass rate
    writing: "openai/gpt-5.4-mini",     // benchmark proven: 89% cheaper, 3.1x faster, 100% pass on STE
    other: "",
  },
};

export const ROLE_MODELS: Record<WorkKind, string> = PROFILE_MODELS.pareto_code;

export const ROLE_THINKING: Record<WorkKind, string> = {
  planning: "high",
  code: "medium",
  writing: "low",
  other: "medium",
};

/** Map prompt text + Jev category -> work kind. Explicit role overrides this. */
export function resolveWorkKind(explicit?: string, category?: string, promptText?: string): WorkKind {
  if (explicit === "planning" || explicit === "code" || explicit === "writing") return explicit;
  const lower = (promptText ?? "").toLowerCase();
  // Clear text-level intent takes precedence where category is ambiguous:
  if (/\b(architecture|architect|design (a|the|some|our)?|system design|rfc|spec|tradeoffs?|rollout plan|plan the)\b/.test(lower)) {
    return "planning";
  }
  if (/\b(write\b.*\b(blog|article|post|essay|copy|paragraph|prose|readme|summary|intro)|draft\b|humanize|polish the text|rewrite|simplified technical english|ste\b)\b/.test(lower)) {
    return "writing";
  }
  switch (category) {
    case "architecture": return "planning";
    case "implementation":
    case "debugging":
    case "mechanical_edit":
    case "review": return "code";
    case "lookup":
    case "explanation": return "writing";
    default: return "other";
  }
}

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

/** Role-aware routing: planning/code/writing get their dedicated model classes. */
export function recommendByRole(
  workKind: WorkKind,
  answers: Record<string, { type: string; value: string | number; confidence?: number }>,
  policy: Policy,
  classifierAvailable: boolean,
  profile: RouterProfile = "pareto_code",
): Recommendation {
  if (workKind === "other" || !classifierAvailable) {
    return recommend(answers, policy, classifierAvailable);
  }
  const modelId = PROFILE_MODELS[profile][workKind];
  const tierIndex = workKind === "planning" ? 2 : workKind === "code" ? 2 : 0;
  return { modelId, tierIndex, reason: "role_policy" };
}