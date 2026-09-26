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
/**
 * Complexity at or above which a task is "hard" for evidence purposes.
 * Complexity 2 is "diagnose or design across several dependent steps" in the
 * classifier's own scale.
 */
export const HARD_COMPLEXITY = 2;
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

/**
 * The role policy you set on 20 September 2026. Planning goes to frontier
 * intelligence. Writing goes to fast OpenAI models, and the STE directive is
 * applied. Code takes the Pareto pick. These are eligibility rules, not
 * weights: inside the eligible set the frontier still decides.
 */

/**
 * Minimum Artificial Analysis intelligence index for planning. It is an
 * absolute score, because a percentile moves each time the catalog adds a
 * model. Placed in the gap from 49.6 (claude-fable-5) to 47.5 (gpt-6-sol).
 * Eligible on 26 September 2026: claude-opus-5.5 (57.6), claude-fable-5.1
 * (53.4), gpt-6-astra (52.7), claude-opus-5 (50.8) and claude-fable-5
 * (49.6). claude-sonnet-5 (38.2) is far below.
 */
export const PLANNING_MIN_INTELLIGENCE = 48.5;
export const WRITING_VENDORS = ["openai/"];
/**
 * Minimum EQ-Bench writing Elo for a writing model from WRITING_VENDORS. An
 * unrated model gets the optimistic prior and then wins on price alone, so
 * gpt-5-nano took every writing task. Placed in the widest gap near the top
 * of the rated, tool-capable OpenAI models: from 1825.8 (gpt-5.6-luna) to
 * 1699.8 (gpt-5.2). Eligible on 26 September 2026: gpt-6-astra, gpt-5.6-sol,
 * gpt-5.6-terra, gpt-5.5, gpt-5.4 and gpt-5.6-luna. An unrated model with
 * PROVEN_RUNS or more measured writing runs is also eligible.
 */
export const WRITING_MIN_ELO = 1760;

/** True when the role policy lets this model take work of this kind. */
export function roleEligible(m: CatalogModel, kind: WorkKind, evidence: EvidenceIndex): boolean {
  if (kind === "planning") return (m.aa?.intelligence ?? 0) >= PLANNING_MIN_INTELLIGENCE;
  if (kind === "writing") {
    if (!WRITING_VENDORS.some((v) => m.id.startsWith(v))) return false;
    return (WRITING_ELO[m.id] ?? 0) >= WRITING_MIN_ELO || (statsFor(evidence, m.id, "writing")?.runs ?? 0) >= PROVEN_RUNS;
  }
  return true;
}

export interface Weights { lambda: number; mu: number }

export const PROFILE_WEIGHTS: Record<WorkKind, Weights> = {
  planning: { lambda: 0.15, mu: 0.05 },
  code: { lambda: 0.45, mu: 0.20 },
  writing: { lambda: 0.80, mu: 0.50 },
  other: { lambda: 0.50, mu: 0.25 },
};

/**
 * Used only when the catalog is unavailable, so no frontier can be computed.
 * These are the best-measured models per kind, not a selection policy.
 * Writing was gpt-5.4-mini until deepseek-v4-flash-0731 reached 12 of 12
 * at a tenth of the price.
 */
export const FALLBACK_MODELS: Record<WorkKind, string> = {
  planning: "anthropic/claude-sonnet-5",
  code: "anthropic/claude-sonnet-5",
  writing: "deepseek/deepseek-v4-flash-0731",
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
  | "relaxed_role_policy"
  | "relaxed_quality_floor"
  | "catalog_unavailable"
  | "classifier_unavailable"
  | "continuation";

export interface Recommendation {
  modelId: string;
  reason: RecommendationReason;
  q?: number;
  cEst?: number;
  tEst?: number;
  candidateCount?: number;
  frontier?: Scored[];
  /** The knee of the same frontier. A diagnostic only: it does not pick. */
  kneeId?: string;
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
  // `\b` does not match between a space and `/`, so `/plan` needs its own test.
  if (/(^|\s)\/plan\b/.test(lower)) return "planning";
  // Clear text-level intent takes precedence where category is ambiguous:
  if (/\b(architecture|architect|design (a|the|some|our)?|system design|rfc|spec|tradeoffs?|rollout plan|plan the|roadmap|plan (this|it|out))\b/.test(lower)) {
    return "planning";
  }
  // A draft/write/make/prepare verb aimed at a plan or roadmap object is
  // planning, not writing, even though "draft" and "write" are otherwise
  // writing verbs below. "for Q1" / "for the rollout" sits between the verb
  // and the object, so the object can trail up to 30 characters back.
  if (/\b(draft|write|make|prepare)\b[^.]{0,30}\b(plan|roadmap)\b/.test(lower)) {
    return "planning";
  }
  if (/\b(write\b.*\b(blog|article|post|essay|copy|paragraph|prose|readme|summary|intro)|draft\b|humanize|polish the text|rewrite|simplified technical english|ste\b)\b/.test(lower)) {
    return "writing";
  }
  // Needs a writing verb, so "fix the changelog generator" stays code. The
  // object must follow the verb within three words, so "write a script to
  // parse the docs directory" does not match on "docs" far down the sentence.
  if (/\b(write|draft|update)\s+(?:\S+\s+){0,3}?(changelog|release notes|docs?|documentation|readme)\b/.test(lower)) return "writing";
  switch (category) {
    case "architecture": return "planning";
    case "implementation":
    case "debugging":
    case "mechanical_edit":
    case "review": return "code";
    case "lookup":
    case "explanation": return "writing";
    case "planning": return "planning";
    case "writing": return "writing";
    default: return "other";
  }
}

function aaIndexFor(m: CatalogModel, kind: WorkKind): number | null {
  if (!m.aa) return null;
  if (kind === "code") return m.aa.coding;
  if (kind === "other") return m.aa.agentic;
  return m.aa.intelligence;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0.5;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

/** Min-max normalise one index across the catalog. Zero and missing are absent. */
export function normalisedIndex(catalog: CatalogModel[], pick: (m: CatalogModel) => number | null): Map<string, number> {
  const raw = new Map<string, number>();
  for (const m of catalog) {
    const v = pick(m);
    if (v !== null && Number.isFinite(v) && v > 0) raw.set(m.id, v);
  }
  const values = [...raw.values()];
  const lo = values.length ? Math.min(...values) : 0;
  const span = (values.length ? Math.max(...values) : 1) - lo || 1;
  const out = new Map<string, number>();
  for (const [id, v] of raw) out.set(id, (v - lo) / span);
  return out;
}

export const MIN_CALIBRATION_MODELS = 3;

/**
 * Anchor quality priors on the range of measured pass rates.
 *
 * A measured model's quality is a pass rate. An unmeasured model's was a rank
 * in the catalog. On one axis the two do not compare. A least-squares fit
 * does not fix this on real data: the fit line runs on only four or five
 * noisy pass rates, and its slope can come out negative (for code) or steep
 * (for planning). A negative slope flattens every prior to one mean value. A
 * steep slope saturates every prior at the cap. Both defeat the point of
 * calibrating at all.
 *
 * Rank order is a steadier signal than a two- or three-point fit line
 * through the noise, so keep it: map rank linearly onto the range the anchor
 * models actually measured, `lo` to `hi`. A higher rank always yields a
 * higher prior, never a lower one, and the prior always lands inside the
 * measured range instead of outside it.
 *
 * `indexed`, when given, restricts the anchor set to models whose rank came
 * from a real index rather than the optimistic catalog fill. A router
 * meta-model with no benchmark data (an `openrouter/pareto-code` for
 * example) can still show measured runs, but its "rank" is a filler value,
 * so it must not set `lo` or `hi` for everyone else.
 */
export function calibrate(
  rank: Map<string, number>,
  evidence: EvidenceIndex,
  kind: WorkKind,
  indexed?: Set<string>,
): Map<string, number> {
  const rates: number[] = [];
  for (const [id, kinds] of Object.entries(evidence)) {
    const s = kinds[kind];
    const r = rank.get(id);
    if (s && s.runs >= PROVEN_RUNS && r !== undefined && (!indexed || indexed.has(id))) {
      rates.push(s.passes / s.runs);
    }
  }
  if (rates.length < MIN_CALIBRATION_MODELS) return rank;
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  if (hi <= lo) return rank;
  const out = new Map<string, number>();
  for (const [id, r] of rank) out.set(id, Math.min(0.99, Math.max(0.05, lo + (hi - lo) * r)));
  return out;
}

/**
 * Quality prior per model. The kind's own index comes first. A model that
 * lists it as zero (the newest frontier models list `coding: 0`) falls back
 * to its intelligence rank rather than the optimistic median, which kept
 * claude-opus-5.5 off the code frontier. With evidence, priors are anchored
 * on the measured pass-rate range.
 */
export function qualityPrior(catalog: CatalogModel[], kind: WorkKind, evidence?: EvidenceIndex): Map<string, number> {
  const primary = kind === "writing"
    ? normalisedIndex(catalog, (m) => WRITING_ELO[m.id] ?? null)
    : normalisedIndex(catalog, (m) => aaIndexFor(m, kind));
  const fallback = kind === "writing" ? new Map<string, number>() : normalisedIndex(catalog, (m) => m.aa?.intelligence ?? null);
  const optimistic = percentile([...primary.values()].sort((a, b) => a - b), OPTIMISTIC_PERCENTILE);
  const rank = new Map<string, number>();
  // A model only anchors the calibration when its rank came from the primary
  // or fallback index. The optimistic fill is a placeholder for a model with
  // no benchmark entry at all, not a measurement, so it must not set the
  // range that every other prior is read off.
  const indexed = new Set<string>();
  for (const m of catalog) {
    const v = primary.get(m.id) ?? fallback.get(m.id);
    if (v !== undefined) indexed.add(m.id);
    rank.set(m.id, v ?? optimistic);
  }
  return evidence ? calibrate(rank, evidence, kind, indexed) : rank;
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
    ignoreRolePolicy?: boolean;
    priors?: Map<string, number>;
    now?: number;
    /** The task is hard: read the hard-suite cell where there is enough of it. */
    hard?: boolean;
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
  if (!opts.ignoreRolePolicy && !roleEligible(m, kind, evidence)) return false;
  if (!opts.ignoreProvenGate && risk >= 2) {
    if ((statsFor(evidence, m.id, kind)?.runs ?? 0) < PROVEN_RUNS) return false;
  }
  // Demonstrated-failure gate. A cheap model can otherwise win on price alone:
  // the writing profile is cost averse enough that a model which failed the
  // writing benchmark still took the knee. Measured failure outranks price.
  if (!opts.ignoreQualityFloor) {
    const st = statsFor(evidence, m.id, kind, { hard: opts.hard });
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
  hard: boolean,
): Scored {
  const st = statsFor(evidence, m.id, kind, { hard });
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
  // The base benchmark suite is passed by nearly every model, so on a hard
  // task it says little. Read the hard-suite cell instead, where there is
  // enough of it.
  const hard = complexity >= HARD_COMPLEXITY;
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

  const priors = qualityPrior(catalog, kind, evidence);
  const { prior: latPrior, present: latPresent } = latencySignal(evidence, kind);

  // The role policy is relaxed after the reasoning requirement, so a role
  // with no eligible model still routes. The quality floor is relaxed last:
  // a measured failure should outrank the proven gate, the reasoning
  // requirement and the role policy.
  const base = { priors, hard };
  const attempts: Array<{ opts: Parameters<typeof feasible>[5]; reason: RecommendationReason }> = [
    { opts: { ...base }, reason: "frontier_tangency" },
    { opts: { ...base, ignoreProvenGate: true }, reason: "relaxed_proven_gate" },
    { opts: { ...base, ignoreProvenGate: true, ignoreReasoning: true }, reason: "relaxed_reasoning" },
    { opts: { ...base, ignoreProvenGate: true, ignoreReasoning: true, ignoreRolePolicy: true }, reason: "relaxed_role_policy" },
    // Last resort: also ignores the role policy and the quality floor. A
    // measured failure still outranks nothing, so this attempt must name
    // itself, not reuse an earlier attempt's reason.
    { opts: { ...base, ignoreProvenGate: true, ignoreReasoning: true, ignoreRolePolicy: true, ignoreQualityFloor: true }, reason: "relaxed_quality_floor" },
  ];

  for (const attempt of attempts) {
    const candidates = catalog.filter((m) => feasible(m, env, risk, kind, evidence, attempt.opts));
    if (candidates.length === 0) continue;
    const scored = candidates.map((m) => score(m, env, kind, evidence, priors, latPrior, hard));
    const front = nondominated(scored);
    const w = PROFILE_WEIGHTS[kind];
    // Complexity scales cost aversion. A hard task tolerates more spend; a
    // trivial one should not pay for capability it will not use. Complexity
    // also picks the evidence cell: `hard` reads the hard-suite runs above.
    const lambda = w.lambda * complexityScale(complexity);
    const measured = new Set(front.filter((m) => (statsFor(evidence, m.id, kind, { hard })?.runs ?? 0) > 0).map((m) => m.id));
    // The weighted value function decides. It is the only rule that reads the
    // role's cost aversion and the task's complexity. The knee led until
    // 26 September, and a replay showed 24 of 24 picks unmoved by complexity.
    // It stays as a diagnostic.
    const tan = tangency(front, lambda, latPresent ? w.mu : 0);
    const kneePick = knee(front, measured);
    const pick = tan?.pick ?? kneePick;
    if (!pick) continue;
    const baseReason: RecommendationReason = tan ? "frontier_tangency" : "frontier_knee";
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
      kneeId: kneePick?.id,
      lambda,
      mu: latPresent ? w.mu : 0,
      complexity,
      risk,
      latencySignal: latPresent,
    };
  }

  return { modelId: FALLBACK_MODELS[kind], reason: "catalog_unavailable" };
}
