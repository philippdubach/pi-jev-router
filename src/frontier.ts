/**
 * Discrete Pareto frontier over quality, cost and latency.
 *
 * Quality rises. Cost and latency fall. Pure functions only.
 */

export interface Scored {
  id: string;
  /** quality in 0..1, higher is better */
  q: number;
  /** expected cost in USD, lower is better */
  c: number;
  /** expected latency in ms, lower is better */
  t: number;
}

/** `a` dominates `b` when `a` is no worse on every axis and better on one. */
export function dominates(a: Scored, b: Scored): boolean {
  const noWorse = a.q >= b.q && a.c <= b.c && a.t <= b.t;
  const better = a.q > b.q || a.c < b.c || a.t < b.t;
  return noWorse && better;
}

export function nondominated(items: Scored[]): Scored[] {
  return items.filter((candidate) => !items.some((other) => dominates(other, candidate)));
}

function minMax(values: number[]): (v: number) => number {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  // A constant axis carries no information, so it normalises to zero.
  if (!Number.isFinite(span) || span === 0) return () => 0;
  return (v: number) => (v - lo) / span;
}

/**
 * Pick the point on the frontier that maximises q - lambda*c - mu*t.
 * Each axis is normalised across the frontier, not across the catalog.
 */
export function tangency(
  frontier: Scored[],
  lambda: number,
  mu: number,
): { pick: Scored; utility: number } | undefined {
  if (frontier.length === 0) return undefined;
  const nq = minMax(frontier.map((m) => m.q));
  const nc = minMax(frontier.map((m) => m.c));
  const nt = minMax(frontier.map((m) => m.t));
  let best = frontier[0];
  let bestU = -Infinity;
  for (const m of frontier) {
    const u = nq(m.q) - lambda * nc(m.c) - mu * nt(m.t);
    if (u > bestU) {
      bestU = u;
      best = m;
    }
  }
  return { pick: best, utility: bestU };
}
