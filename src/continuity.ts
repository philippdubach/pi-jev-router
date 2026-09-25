/**
 * Decisions that depend on the previous turn rather than on this prompt alone.
 *
 * Pure functions. The extension owns the state and passes it in.
 */
import type { WorkKind } from "./selector.ts";

/**
 * A continuation carries no task of its own. In a real five-day session the
 * prompts "continue" and "work through the full roadmap" classified as
 * `unclear` at 0.75 to 0.97 confidence even with session context, because the
 * earlier turns were continuations too. Jev was right: the text names no task.
 * The task is whatever the previous classified turn was about.
 */
export const CONTINUATION_MAX_WORDS = 12;

export interface InheritResult {
  workKind: WorkKind;
  inherited: boolean;
}

export function inheritWorkKind(
  resolved: WorkKind,
  category: string,
  prompt: string,
  previous: WorkKind | undefined,
): InheritResult {
  if (resolved !== "other") return { workKind: resolved, inherited: false };
  if (category && category !== "unclear") return { workKind: resolved, inherited: false };
  if (!previous || previous === "other") return { workKind: resolved, inherited: false };
  const words = prompt.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0 || words > CONTINUATION_MAX_WORDS) return { workKind: resolved, inherited: false };
  return { workKind: previous, inherited: true };
}

/**
 * Tokens are counted in the current model's tokenizer, but the context limit
 * belongs to the target model. The same session measured 971,377 tokens on
 * DeepSeek and 1,429,528 on Anthropic, a ratio of 1.47. A guard that compares
 * the two directly lets a switch through that the target then rejects.
 *
 * Within one vendor the tokenizer is shared, so no margin applies.
 */
export const CROSS_TOKENIZER_MARGIN = 1.5;

/** Vendor family of a model, from its id or its provider. */
export function tokenizerFamily(provider: string | undefined, modelId: string | undefined): string {
  const id = modelId ?? "";
  const slash = id.indexOf("/");
  if (slash > 0) return id.slice(0, slash).replace(/^~/, "").toLowerCase();
  const p = (provider ?? "").toLowerCase();
  if (p === "openai-codex") return "openai";
  return p;
}

export function estimateTargetTokens(
  tokens: number,
  from: { provider?: string; id?: string },
  to: { provider?: string; id?: string },
): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  const same = tokenizerFamily(from.provider, from.id) === tokenizerFamily(to.provider, to.id);
  return same ? tokens : Math.ceil(tokens * CROSS_TOKENIZER_MARGIN);
}

/** Whether switching to `to` is a no-op. */
export function isSameModel(
  current: { provider?: string; id?: string } | undefined,
  target: { provider?: string; id?: string },
): boolean {
  return !!current && current.provider === target.provider && current.id === target.id;
}
