// Prior calibration — run: node --experimental-strip-types tests/prior-calibration.test.ts
import { calibrate, qualityPrior, normalisedIndex } from "../src/selector.ts";
import type { CatalogModel } from "../src/catalog.ts";
import type { EvidenceIndex } from "../src/evidence.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
  if (!ok) failed++;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const st = (runs: number, passes: number) => ({ runs, passes, meanCostUsd: 0.01, meanLatencyMs: 1000 });

const rank = new Map([["m/a", 0.2], ["m/b", 0.5], ["m/c", 0.8], ["m/new", 1.0]]);
// Pass rates: m/a 0.6, m/b 0.75, m/c 0.9. lo = 0.6, hi = 0.9.
const ev: EvidenceIndex = { "m/a": { code: st(10, 6) }, "m/b": { code: st(8, 6) }, "m/c": { code: st(10, 9) } };
const cal = calibrate(rank, ev, "code");
check("rank maps linearly onto the measured pass-rate range", near(cal.get("m/b")!, 0.75), String(cal.get("m/b")));
check("unmeasured top rank lands on the top measured pass rate", near(cal.get("m/new")!, 0.9), String(cal.get("m/new")));

const few: EvidenceIndex = { "m/a": { code: st(10, 6) }, "m/b": { code: st(8, 6) } };
check("fewer than three measured models: rank unchanged", calibrate(rank, few, "code").get("m/new") === 1.0);

// Pass rates run the other way from rank (m/a highest, m/c lowest). A linear
// map keeps rank order regardless: a higher rank still gets a higher prior,
// unlike a least-squares fit, which would flatten this to one mean value.
const backwards: EvidenceIndex = { "m/a": { code: st(10, 9) }, "m/b": { code: st(8, 6) }, "m/c": { code: st(10, 6) } };
const order = calibrate(rank, backwards, "code");
check(
  "order is preserved even when pass rates run opposite to rank",
  order.get("m/new")! > order.get("m/a")!,
  `${order.get("m/new")} vs ${order.get("m/a")}`,
);
check(
  "the two priors do not collapse to one flat mean",
  !near(order.get("m/a")!, order.get("m/new")!),
  `${order.get("m/a")} ${order.get("m/new")}`,
);

// m/c has a clean 9/10 record and would set hi = 0.9 if it anchored the
// range (as in the first check above). Leaving it out of `indexed` drops the
// anchor count for "code" to two (m/a, m/b), below MIN_CALIBRATION_MODELS, so
// the whole calibration is skipped and the raw rank passes through instead.
const excluded = calibrate(rank, ev, "code", new Set(["m/a", "m/b"]));
check(
  "a measured model outside the indexed set does not anchor the range",
  excluded.get("m/new") === 1.0,
  String(excluded.get("m/new")),
);

const model = (id: string, aa: CatalogModel["aa"]): CatalogModel => ({
  id, contextLength: 1e6, promptPrice: 1e-6, completionPrice: 5e-6, supportsTools: true,
  supportsReasoning: true, inputModalities: ["text"], expiresAt: null, aa,
});
const cat = [
  model("x/low", { intelligence: 20, coding: 50, agentic: 20 }),
  model("x/high", { intelligence: 40, coding: 80, agentic: 40 }),
  model("x/newest", { intelligence: 40, coding: 0, agentic: 0 }),
];
const intel = normalisedIndex(cat, (m) => m.aa?.intelligence ?? null);
check("zero coding index falls back to intelligence rank", qualityPrior(cat, "code").get("x/newest") === intel.get("x/newest"),
  String(qualityPrior(cat, "code").get("x/newest")));
process.exit(failed ? 1 : 0);
