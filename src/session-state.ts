/**
 * Pure helpers for state the extension keeps across turns.
 */

/**
 * Cost of one finished message, or zero. The budget gate counted classifier
 * and worker spend only, so `/router budget` never saw the model tokens it
 * is meant to cap.
 */
export function assistantCost(message: unknown): number {
  const m = message as any;
  if (m?.role !== "assistant") return 0;
  const c = Number(m?.usage?.cost?.total);
  return Number.isFinite(c) && c > 0 ? c : 0;
}

/**
 * Whether the catalog and evidence loaded at session start are stale. A pi
 * session loads them once, and new benchmark results used to reach it only
 * after a restart.
 */
export function shouldReload(
  loaded: { at: number; resultsMtimeMs: number },
  now: number,
  resultsMtimeMs: number,
  ttlMs: number,
): boolean {
  return now - loaded.at >= ttlMs || resultsMtimeMs > loaded.resultsMtimeMs;
}
