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
/**
 * The knee: the frontier point farthest above the chord.
 *
 * `measured` is the set of ids with recorded evidence for this work kind.
 * When at least two of them sit on the frontier, the chord is drawn between
 * the cheapest measured point and the best measured point rather than the
 * frontier's extremes. Otherwise the pick depends on whichever unmeasured
 * preview happens to be listed cheapest or best that week: removing a $0
 * stealth model once moved the code route from one model to another.
 * Unmeasured models may still win if they sit above the measured chord.
 */
export function knee(frontier: Scored[], measured?: Set<string>): Scored | undefined {
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

  // Chord endpoints: measured extremes when there are two or more measured
  // points on the frontier, else the frontier's extremes.
  const idx = frontier.map((_, i) => i);
  const measuredIdx = measured ? idx.filter((i) => measured.has(frontier[i].id)) : [];
  const pool = measuredIdx.length >= 2 ? measuredIdx : idx;
  const lo = pool.reduce((a, b) => (x[b] < x[a] ? b : a));
  const hi = pool.reduce((a, b) => (y[b] > y[a] || (y[b] === y[a] && x[b] < x[a]) ? b : a));
  // One measured model that is both the cheapest and the best measured
  // point dominates the measured set. The chord has no length, and that
  // model is the knee. Without this, the fallback value function once
  // chose an unmeasured model at a lower price over a 12-of-12 measured one.
  if (lo === hi && measuredIdx.length >= 2) return frontier[lo];
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
  // A chord is a segment. A point beyond either anchor's cost can register
  // "above" the extended line while being the worst value on the frontier;
  // with a measured chord ling -> sonnet, fable at 7x sonnet's price did
  // exactly that. Only points within the anchors' cost span are candidates.
  const xLo = Math.min(x[lo], x[hi]);
  const xHi = Math.max(x[lo], x[hi]);
  const dist = x.map((v, i) => {
    if (v < xLo - EPS || v > xHi + EPS) return -Infinity;
    return (dx * (y[i] - y[lo]) - dy * (v - x[lo])) / len;
  });
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
/** Reference spans for the weighted value function, in doublings. */
export const COST_SPAN_DOUBLINGS = 10;   // ~1000x: cheapest to dearest capable model
export const LATENCY_SPAN_DOUBLINGS = 3; // ~8x: a fast model to a slow one

export function tangency(
  frontier: Scored[],
  lambda: number,
  mu: number,
): { pick: Scored; utility: number } | undefined {
  if (frontier.length === 0) return undefined;

  const positiveCosts = frontier.map((m) => m.c).filter((c) => c > 0);
  const cMin = positiveCosts.length ? Math.min(...positiveCosts) : 0;
  const cMax = positiveCosts.length ? Math.max(...positiveCosts) : 0;
  const positiveTs = frontier.map((m) => m.t).filter((t) => t > 0);
  const tMin = positiveTs.length ? Math.min(...positiveTs) : 0;
  const tMax = positiveTs.length ? Math.max(...positiveTs) : 0;

  // Cost and latency are log ratios from the frontier minimum, divided by
  // a fixed reference span, so lambda means "spanning COST_SPAN doublings
  // is worth lambda of quality" whatever happens to be on the frontier.
  //
  // Two earlier versions got this wrong. The raw log ratio made one
  // doubling worth lambda, so at 0.8 no quality gain could justify 2x the
  // price. Normalising to the frontier's own span fixed cost but broke
  // latency: a 12s-21s spread is under one doubling, and stretching it to
  // [0, 1] made a 12-of-12 model's extra nine seconds cost half the quality
  // range. If the frontier is wider than the reference, its own span is
  // used so no value exceeds 1.
  const cSpan = Math.max(COST_SPAN_DOUBLINGS, cMin > 0 && cMax > cMin ? logRatio(cMax, cMin) : 0);
  const tSpan = Math.max(LATENCY_SPAN_DOUBLINGS, tMin > 0 && tMax > tMin ? logRatio(tMax, tMin) : 0);

  let best = frontier[0];
  let bestU = -Infinity;
  for (const m of frontier) {
    const xc = cSpan > 0 ? logRatio(m.c, cMin) / cSpan : 0;
    const xt = tSpan > 0 ? logRatio(m.t, tMin) / tSpan : 0;
    const u = m.q - lambda * xc - mu * xt;
    if (u > bestU) {
      bestU = u;
      best = m;
    }
  }
  return { pick: best, utility: bestU };
}