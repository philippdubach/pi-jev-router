// Pareto frontier — run: node --experimental-strip-types tests/frontier.test.ts
import { dominates, nondominated, knee, tangency, type Scored } from "../src/frontier.ts";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(ok ? "PASS" : "FAIL", name);
  if (!ok) failed++;
};

const s = (id: string, q: number, c: number, t: number): Scored => ({ id, q, c, t });

check("strictly better dominates", dominates(s("a", 0.9, 1, 1), s("b", 0.5, 1, 1)));
check("cheaper dominates", dominates(s("a", 0.5, 1, 1), s("b", 0.5, 2, 1)));
check("faster dominates", dominates(s("a", 0.5, 1, 1), s("b", 0.5, 1, 2)));
check("identical does not dominate", !dominates(s("a", 0.5, 1, 1), s("b", 0.5, 1, 1)));
check("mixed does not dominate", !dominates(s("a", 0.9, 5, 1), s("b", 0.5, 1, 1)));

const mixed = [
  s("cheap-weak", 0.30, 0.01, 10),
  s("mid", 0.60, 0.10, 20),
  s("strong-costly", 0.95, 1.00, 30),
  s("dominated", 0.50, 0.50, 40),
];
const f = nondominated(mixed).map((x) => x.id).sort();
check("keeps the three non-dominated", f.join(",") === "cheap-weak,mid,strong-costly");
check("drops the dominated one", !f.includes("dominated"));

check("empty input", nondominated([]).length === 0);
check("single item is its own frontier", nondominated([s("solo", 0.5, 1, 1)]).length === 1);

const allEqual = [s("a", 0.5, 1, 1), s("b", 0.5, 1, 1)];
check("ties are all non-dominated", nondominated(allEqual).length === 2);

const one = [s("only", 0.42, 3, 7)];
check("one dominator collapses the set", nondominated([...one, s("worse", 0.1, 9, 9)]).length === 1);

// --- knee ---
// `mid` in the mixed fixture sits BELOW the chord: q=0.60 for $0.10 is a
// worse deal than the straight line from cheap-weak to strong-costly. That
// is not a bend worth exploiting, so it must not be the knee. The unsigned
// rule picked it anyway, and on a live frontier the same fault chose a
// $0.33 model over a $0.0009 model measured at 19 of 21.
const frontier = nondominated(mixed);
check("a point below the chord is not a knee", knee(frontier) === undefined);

// A true bend: most of the quality arrives early, then cost climbs for little.
const bent = [s("cheap", 0.30, 0.01, 1), s("value", 0.85, 0.05, 1), s("costly", 0.95, 1.00, 1)];
check("knee is the point above the chord", knee(bent)!.id === "value");

// Two points above the chord: the farther one wins.
const twoAbove = [s("a", 0.30, 0.01, 1), s("b", 0.70, 0.02, 1), s("c", 0.90, 0.05, 1), s("d", 0.95, 1.00, 1)];
check("the farthest point above the chord wins", knee(twoAbove)!.id === "c");

// Concave frontier: every interior point below the chord, no knee at all,
// so the caller falls back to the weighted value function.
const concave = [s("a", 0.88, 0.001, 1), s("b", 0.93, 0.05, 1), s("c", 0.95, 0.09, 1), s("d", 0.954, 0.33, 1), s("e", 1.0, 0.66, 1)];
check("concave frontier has no knee", knee(concave) === undefined);
check("knee ignores a two-point frontier", knee([s("a", 0.2, 0.01, 1), s("b", 0.9, 1, 1)]) === undefined);
check("knee of empty frontier is undefined", knee([]) === undefined);
const collinear = [s("a", 0.5, 0.01, 1), s("b", 0.6, 0.1, 1), s("c", 0.7, 1.0, 1)];
check("knee of a flat frontier is undefined", knee(collinear) === undefined);

// --- tangency (log ratio over a fixed reference span) ---
// Lambda is the quality worth of spanning COST_SPAN_DOUBLINGS (10). On the
// mixed fixture the span is 0.01 -> 1.00, 6.64 doublings, so strong-costly
// sits at x=0.66, mid at x=0.33, cheap-weak at x=0.
// Cost is a ratio, so lambda trades quality for doublings of cost.
check("zero lambda picks strong", tangency(frontier, 0, 0)!.pick.id === "strong-costly");
check("a small lambda still picks strong", tangency(frontier, 0.05, 0)!.pick.id === "strong-costly");
check("a moderate lambda still picks strong", tangency(frontier, 0.5, 0)!.pick.id === "strong-costly");
check("a large lambda picks cheap", tangency(frontier, 1.5, 0)!.pick.id === "cheap-weak");
check("a huge lambda picks cheap", tangency(frontier, 20, 0)!.pick.id === "cheap-weak");
check("empty frontier returns undefined", tangency([], 1, 1) === undefined);

const flatCost = [s("a", 0.2, 1, 1), s("b", 0.8, 1, 1)];
check("constant axis is inert", tangency(flatCost, 9, 9)!.pick.id === "b");

const withFree = [s("free", 0.7, 0, 1), s("paid", 0.6, 0.1, 1)];
check("a free model does not break the ratio", tangency(withFree, 5, 0)!.pick.id === "free");

// --- knee anchored on measured models ---
// A measured pair (a, b, c) and unmeasured extremes (z cheaper, w better).
// The pick must not change when the extremes appear or disappear.
const measured = new Set(["a", "b", "c"]);
const core = [s("a", 0.70, 0.01, 1), s("b", 0.90, 0.02, 1), s("c", 0.95, 0.10, 1)];
const withExtremes = [s("z", 0.50, 0.001, 1), ...core, s("w", 1.00, 1.00, 1)];
check("anchored knee on the core", knee(core, measured)?.id === "b");
check("anchored knee ignores unmeasured extremes", knee(withExtremes, measured)?.id === "b");
// Without anchoring the extremes move the chord and can move the pick.
const unanchored = knee(withExtremes)?.id;
check("unanchored knee is reported for contrast", typeof unanchored === "string" || unanchored === undefined);
// An unmeasured model above the measured chord may still win.
const bargain = [...core, s("u", 0.94, 0.012, 1)]; // nearly c's quality at near a's price
check("unmeasured bargain above the chord wins", knee(bargain, measured)?.id === "u");
// Fewer than two measured points on the frontier: fall back to full chord.
check("one measured point falls back to full chord", knee(withExtremes, new Set(["b"]))?.id === knee(withExtremes)?.id);

// One measured model dominating the other measured models is the knee, even
// with a cheaper unmeasured point on the frontier.
const dominant = [s("cheap-unmeasured", 0.76, 0.0009, 1), s("best-measured", 0.97, 0.0017, 1), s("weak-measured", 0.68, 0.0034, 1), s("dear", 1.0, 0.66, 1)];
check("dominant measured model is the knee", knee(dominant, new Set(["best-measured", "weak-measured"]))?.id === "best-measured");
process.exit(failed ? 1 : 0);
