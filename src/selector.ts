/**
 * Model selection over the OpenRouter catalog.
 *
 * Pure functions only. No network call. No file read. The caller supplies the
 * catalog and the evidence. Jev output is evidence, never a guarantee.
 */
import type { CatalogModel } from "./catalog.ts";
import { statsFor, type EvidenceIndex } from "./evidence.ts";
import { knee, nondominated, tangency, type Scored } from "./frontier.ts";
import type { ClassificationResult, TaskEnvelope } from "./task-envelope.ts";
import { WRITING_ELO } from "./writing-prior.ts";

export const K = 5;
export const PROVEN_RUNS = 3;
/** Pseudo-count anchoring the pass-rate posterior to the catalog prior. */
export const EVIDENCE_PSEUDO_COUNT = 2;
/**
 * A model with measured runs must keep a posterior above this to stay
 * eligible. Applies only once evidence exists, so an untested model is not
 * blocked by it.
 *
 * Placed in the widest gap in the measured distribution rather than by taste.
 * Across 63 runs the posteriors fall at 0.584, 0.584, then 0.712 and upward,
 * so 0.65 separates the cells measured at half their runs from every cell with
 * a clear majority. A floor inside a cluster would flip on one more run, which
 * is how an earlier turn budget placed at the median went wrong.
 */
export const QUALITY_FLOOR = 0.65;

/**
 * Confidence above which a `clarify` brief answer stops routing. Below it the
 * classifier is guessing about readiness and the pick proceeds as normal.
 */
export const BRIEF_ABSTAIN_CONFIDENCE = 0.7;

/**
 * Map complexity in [0, 3] to a multiplier on cost aversion. Complexity 0
 * (a fully specified mechanical step) is 1.5x as cost averse as the profile
 * default; complexity 3 (ambiguous, cross-system) is half as cost averse.
 * Linear between, clamped outside.
 */
export function complexityScale(complexity: number): number {
  const c = Math.min(3, Math.max(0, Number.isFinite(complexity) ? complexity : 1));
  return 1.5 - c / 3;
}

/** Decompose probability above which the router suggests dispatching. */
export const DECOMPOSE_HINT_THRESHOLD = 0.7;
export const CONTEXT_HEADROOM = 1.3;
const DEFAULT_TURNS = 4;
const DEFAULT_OUTPUT_TOKENS = 1500;
const OPTIMISTIC_PERCENTILE = 0.6;

export type WorkKind = "planning" | "code" | "writing" | "other";

export interface Weights { lambda: number; mu: number }

export const PROFILE_WEIGHTS: Record<WorkKind, Weights> = {
  planning: { lambda: 0.15, mu: 0.05 },
  code: { lambda: 0.45, mu: 0.20 },
  writing: { lambda: 0.80, mu: 0.50 },
  other: { lambda: 0.50, mu: 0.25 },
};

/**
 * Used only when the catalog is unavailable, so no frontier can be computed.
 * These are known-good models, not a selection policy.
 */
export const FALLBACK_MODELS: Record<WorkKind, string> = {
  planning: "anthropic/claude-sonnet-5",
  code: "anthropic/claude-sonnet-5",
  writing: "openai/gpt-5.4-mini",
  other: "anthropic/claude-sonnet-5",
};

export const ROLE_THINKING: Record<WorkKind, string> = {
  planning: "high",
  code: "medium",
  writing: "low",
  other: "medium",
};

export type RecommendationReason =
  | "brief_unclear"
  | "frontier_knee"
  | "frontier_tangency"
  | "relaxed_proven_gate"
  | "relaxed_reasoning"
  | "catalog_unavailable"
  | "classifier_unavailable";

export interface Recommendation {
  modelId: string;
  reason: RecommendationReason;
  q?: number;
  cEst?: number;
  tEst?: number;
  candidateCount?: number;
  frontier?: Scored[];
  lambda?: number;
  mu?: number;
  complexity?: number;
  risk?: number;
  latencySignal?: boolean;
  /** Set when the pick was withheld because the brief was not ready. */
  briefConfidence?: number;
}

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

function aaIndexFor(m: CatalogModel, kind: WorkKind): number | null {
  if (!m.aa) return null;
  if (kind === "code") return m.aa.coding;
  if (kind === "other") return m.aa.agentic;
  return m.aa.intelligence;
}

/** Raw quality signal per work kind. Writing uses EQ-Bench, not the AA index. */
function rawQualityFor(m: CatalogModel, kind: WorkKind): number | null {
  if (kind === "writing") return WRITING_ELO[m.id] ?? null;
  return aaIndexFor(m, kind);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0.5;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Normalised quality prior per model. Models without a benchmark entry receive
 * an optimistic prior so they can win low-risk work and earn evidence.
 */
export function qualityPrior(catalog: CatalogModel[], kind: WorkKind): Map<string, number> {
  const raw = new Map<string, number>();
  for (const m of catalog) {
    const v = rawQualityFor(m, kind);
    if (v !== null && Number.isFinite(v) && v > 0) raw.set(m.id, v);
  }
  const values = [...raw.values()];
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const span = hi - lo || 1;
  const normalised = new Map<string, number>();
  for (const [id, v] of raw) normalised.set(id, (v - lo) / span);
  const sorted = [...normalised.values()].sort((a, b) => a - b);
  const optimistic = percentile(sorted, OPTIMISTIC_PERCENTILE);
  const out = new Map<string, number>();
  for (const m of catalog) out.set(m.id, normalised.get(m.id) ?? optimistic);
  return out;
}

function needsReasoning(kind: WorkKind): boolean {
  return kind === "planning" || kind === "code";
}

export function feasible(
  m: CatalogModel,
  env: TaskEnvelope,
  risk: number,
  kind: WorkKind,
  evidence: EvidenceIndex,
  opts: {
    ignoreProvenGate?: boolean;
    ignoreReasoning?: boolean;
    ignoreQualityFloor?: boolean;
    priors?: Map<string, number>;
    now?: number;
  } = {},
): boolean {
  const now = opts.now ?? Date.now();
  // Sentinel and serving-mode guards. A negative price is a router meta-model,
  // not a billable model. Batch is asynchronous, free is rate-limited, and
  // neither is an interactive endpoint.
  // A zero price is an unpublished price, not a free lunch. Every zero-priced
  // entry in the live catalog was either a `:free` variant or an unbenchmarked
  // stealth preview, and the optimistic prior put one of those on the frontier
  // at $0.0000. Gate on price so a renamed variant cannot slip past the name
  // check below.
  if (m.promptPrice <= 0 || m.completionPrice <= 0) return false;
  if (/:(batch|free|extended)$/.test(m.id) || /\/(auto|auto-beta|free)$/.test(m.id)) return false;
  if (m.contextLength < env.facts.estimatedContextTokens * CONTEXT_HEADROOM) return false;
  if (!m.supportsTools) return false;
  if (!opts.ignoreReasoning && needsReasoning(kind) && !m.supportsReasoning) return false;
  if (!m.inputModalities.includes("text")) return false;
  if (env.facts.hasImages && !m.inputModalities.includes("image")) return false;
  if (m.expiresAt !== null && m.expiresAt <= now) return false;
  if (!opts.ignoreProvenGate && risk >= 2) {
    if ((statsFor(evidence, m.id, kind)?.runs ?? 0) < PROVEN_RUNS) return false;
  }
  // Demonstrated-failure gate. A cheap model can otherwise win on price alone:
  // the writing profile is cost averse enough that a model which failed the
  // writing benchmark still took the knee. Measured failure outranks price.
  if (!opts.ignoreQualityFloor) {
    const st = statsFor(evidence, m.id, kind);
    if (st && st.runs > 0) {
      const prior = opts.priors?.get(m.id) ?? 0.5;
      if (posteriorQuality(st.passes, st.runs, prior) < QUALITY_FLOOR) return false;
    }
  }
  return true;
}

function shrink(n: number): number {
  return n / (n + K);
}

/**
 * Posterior pass rate for one model and work kind.
 *
 * The observed rate is smoothed toward the catalog prior, not toward 0.5.
 * Smoothing toward 0.5 mixes two incompatible scales: an absolute pass rate
 * and a prior that is a min-max rank within the catalog. It also punishes a
 * clean record, because (passes + 1) / (runs + 2) cannot exceed the prior
 * until many runs accumulate. Sonnet passing 3 of 3 coding tasks scored below
 * its own prior under that rule.
 *
 * Smoothing toward the prior keeps an untested model at its prior, lets a
 * clean record raise it, and lets failures pull it down hard.
 */
export function posteriorQuality(passes: number, runs: number, prior: number): number {
  if (!Number.isFinite(runs) || runs <= 0) return prior;
  const observed = Math.min(Math.max(passes, 0), runs);
  return (observed + EVIDENCE_PSEUDO_COUNT * prior) / (runs + EVIDENCE_PSEUDO_COUNT);
}

function score(
  m: CatalogModel,
  env: TaskEnvelope,
  kind: WorkKind,
  evidence: EvidenceIndex,
  priors: Map<string, number>,
  latencyPrior: number,
): Scored {
  const st = statsFor(evidence, m.id, kind);
  const n = st?.runs ?? 0;
  const w = shrink(n);

  const qPrior = priors.get(m.id) ?? 0.5;
  const q = st ? posteriorQuality(st.passes, st.runs, qPrior) : qPrior;

  const cEstimate =
    DEFAULT_TURNS *
    (m.promptPrice * env.facts.estimatedContextTokens + m.completionPrice * DEFAULT_OUTPUT_TOKENS);
  const c = w * (st?.meanCostUsd ?? 0) + (1 - w) * cEstimate;

  const t = w * (st?.meanLatencyMs ?? 0) + (1 - w) * latencyPrior;

  return { id: m.id, q, c, t };
}

/** Median observed latency for the kind, or zero when there is no signal. */
function latencySignal(evidence: EvidenceIndex, kind: WorkKind): { prior: number; present: boolean } {
  const observed: number[] = [];
  for (const kinds of Object.values(evidence)) {
    const st = kinds[kind];
    if (st && Number.isFinite(st.meanLatencyMs)) observed.push(st.meanLatencyMs);
  }
  if (observed.length < 2) return { prior: 0, present: false };
  observed.sort((a, b) => a - b);
  return { prior: observed[Math.floor(observed.length / 2)], present: true };
}

export function selectModel(
  env: TaskEnvelope,
  classification: ClassificationResult,
  catalog: CatalogModel[],
  evidence: EvidenceIndex,
  kind: WorkKind,
): Recommendation {
  const answers = classification.answers ?? {};
  const complexity = typeof answers.complexity?.value === "number" ? answers.complexity.value : 1;
  const rawRisk = typeof answers.risk?.value === "number" ? answers.risk.value : 1;
  // A task that was not classified must not clear the proven gate on a guess.
  const risk = classification.classifierUnavailable ? 3 : rawRisk;

  // A brief the classifier is confident is not ready to act on should not be
  // routed. Switching models does not make an ill-defined task well-defined;
  // it only changes which model asks the clarifying question. Leave the
  // current model in place and say so.
  const brief = answers.brief;
  if (
    !classification.classifierUnavailable &&
    brief?.value === "clarify" &&
    typeof brief.confidence === "number" &&
    brief.confidence >= BRIEF_ABSTAIN_CONFIDENCE
  ) {
    return { modelId: "", reason: "brief_unclear", complexity, risk, briefConfidence: brief.confidence };
  }

  if (catalog.length === 0) {
    return { modelId: FALLBACK_MODELS[kind], reason: "catalog_unavailable" };
  }

  const priors = qualityPrior(catalog, kind);
  const { prior: latPrior, present: latPresent } = latencySignal(evidence, kind);

  // The quality floor is relaxed last: a measured failure should outrank both
  // the proven gate and the reasoning requirement.
  const attempts: Array<{ opts: Parameters<typeof feasible>[5]; reason: RecommendationReason }> = [
    { opts: { priors }, reason: "frontier_tangency" },
    { opts: { priors, ignoreProvenGate: true }, reason: "relaxed_proven_gate" },
    { opts: { priors, ignoreProvenGate: true, ignoreReasoning: true }, reason: "relaxed_reasoning" },
    { opts: { priors, ignoreProvenGate: true, ignoreReasoning: true, ignoreQualityFloor: true }, reason: "relaxed_reasoning" },
  ];

  for (const attempt of attempts) {
    const candidates = catalog.filter((m) => feasible(m, env, risk, kind, evidence, attempt.opts));
    if (candidates.length === 0) continue;
    const scored = candidates.map((m) => score(m, env, kind, evidence, priors, latPrior));
    const front = nondominated(scored);
    const w = PROFILE_WEIGHTS[kind];
    // The knee leads. A frontier too small or too flat for a knee falls back to
    // the weighted value function. Both read the live frontier, so the pick
    // follows the catalog and the recorded evidence on every task.
    // Complexity scales cost aversion. A hard task tolerates more spend; a
    // trivial one should not pay for capability it will not use. The
    // classifier's complexity score is otherwise computed and never read.
    const lambda = w.lambda * complexityScale(complexity);
    const kneePick = knee(front);
    const pick = kneePick ?? tangency(front, lambda, latPresent ? w.mu : 0)?.pick;
    if (!pick) continue;
    const baseReason: RecommendationReason = kneePick ? "frontier_knee" : "frontier_tangency";
    return {
      modelId: pick.id,
      reason: classification.classifierUnavailable
        ? "classifier_unavailable"
        : attempt.reason === "frontier_tangency"
          ? baseReason
          : attempt.reason,
      q: pick.q,
      cEst: pick.c,
      tEst: pick.t,
      candidateCount: candidates.length,
      frontier: front,
      lambda,
      mu: latPresent ? w.mu : 0,
      complexity,
      risk,
      latencySignal: latPresent,
    };
  }

  return { modelId: FALLBACK_MODELS[kind], reason: "catalog_unavailable" };
}
