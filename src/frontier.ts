/**
 * Discrete Pareto frontier over quality, cost and latency.
 *
 * Quality rises. Cost and latency fall. Pure functions only.
 *
 * Two selection rules live here:
 * - `knee` picks the best-balanced frontier point with no weights at all.
 * - `tangency` picks by a weighted value function. It is the fallback for
 *   frontiers too small or too flat for a knee to mean anything.
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

const EPS = 1e-9;

/** log2 of a cost ratio, anchored at the cheapest positive cost. Free models sit at zero. */
function logRatio(value: number, floor: number): number {
  if (floor <= 0) return 0;
  return Math.log2(Math.max(value, floor) / floor);
}

/**
 * The knee point: the frontier member farthest from the chord that joins the
 * cheapest and the dearest member, in (quality, log cost) space.
 *
 * Returns `undefined` when a knee is not defined: fewer than three members, no
 * cost spread, no quality spread, or a flat (collinear) frontier. The caller
 * decides the fallback.
 */
export function knee(frontier: Scored[]): Scored | undefined {
  if (frontier.length < 3) return undefined;

  const positiveCosts = frontier.map((m) => m.c).filter((c) => c > 0);
  const cMin = positiveCosts.length ? Math.min(...positiveCosts) : 0;
  const cMax = Math.max(...frontier.map((m) => m.c));
  if (cMin <= 0 || cMax <= cMin) return undefined;

  const qs = frontier.map((m) => m.q);
  const qMin = Math.min(...qs);
  const qMax = Math.max(...qs);
  if (qMax <= qMin) return undefined;

  const denom = Math.log2(cMax / cMin);
  const x = frontier.map((m) => logRatio(m.c, cMin) / denom);
  const y = frontier.map((m) => (m.q - qMin) / (qMax - qMin));

  const lo = x.indexOf(Math.min(...x));
  const hi = x.indexOf(Math.max(...x));
  const dx = x[hi] - x[lo];
  const dy = y[hi] - y[lo];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return undefined;

  // Signed distance, positive above the chord. A point above the chord has
  // gained more quality than its cost position on the line predicts: a
  // good-value bend. A point below has paid for quality it did not receive.
  //
  // The unsigned version chose the farthest point in either direction. On a
  // concave frontier, where each extra dollar buys less, every interior point
  // sits below the chord, and the unsigned rule picked the worst value on the
  // curve: a $0.33 model over a $0.0009 model measured at 19 of 21.
  const dist = x.map((v, i) => (dx * (y[i] - y[lo]) - dy * (v - x[lo])) / len);
  const maxDist = Math.max(...dist);
  // Nothing above the chord means no bend to exploit. Return undefined so the
  // caller falls back to the weighted value function, which can pick an
  // endpoint.
  if (maxDist <= EPS) return undefined;

  const ties = frontier.filter((_, i) => maxDist - dist[i] <= EPS);
  ties.sort((a, b) => b.q - a.q || a.c - b.c || a.id.localeCompare(b.id));
  return ties[0];
}

/**
 * Pick the point that maximises q - lambda*log2(c/c_min) - mu*log2(t/t_min).
 *
 * The cost and latency terms are ratios, so lambda is quality surrendered per
 * doubling of cost. A free model has no cost term. A frontier with no cost
 * spread has an inert cost term.
 */
export function tangency(
  frontier: Scored[],
  lambda: number,
  mu: number,
): { pick: Scored; utility: number } | undefined {
  if (frontier.length === 0) return undefined;

  const positiveCosts = frontier.map((m) => m.c).filter((c) => c > 0);
  const cMin = positiveCosts.length ? Math.min(...positiveCosts) : 0;
  const positiveTs = frontier.map((m) => m.t).filter((t) => t > 0);
  const tMin = positiveTs.length ? Math.min(...positiveTs) : 0;

  let best = frontier[0];
  let bestU = -Infinity;
  for (const m of frontier) {
    const u = m.q - lambda * logRatio(m.c, cMin) - mu * logRatio(m.t, tMin);
    if (u > bestU) {
      bestU = u;
      best = m;
    }
  }
  return { pick: best, utility: bestU };
}