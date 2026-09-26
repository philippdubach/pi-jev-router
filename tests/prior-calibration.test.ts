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
const ev: EvidenceIndex = { "m/a": { code: st(10, 6) }, "m/b": { code: st(8, 6) }, "m/c": { code: st(10, 9) } };
const cal = calibrate(rank, ev, "code");
check("fit passes through the measured mean", near(cal.get("m/b")!, 0.75), String(cal.get("m/b")));
check("unmeasured top rank lands on the pass scale", near(cal.get("m/new")!, 0.99), String(cal.get("m/new")));

const few: EvidenceIndex = { "m/a": { code: st(10, 6) }, "m/b": { code: st(8, 6) } };
check("fewer than three measured models: rank unchanged", calibrate(rank, few, "code").get("m/new") === 1.0);

const backwards: EvidenceIndex = { "m/a": { code: st(10, 9) }, "m/b": { code: st(8, 6) }, "m/c": { code: st(10, 6) } };
const flat = calibrate(rank, backwards, "code");
check("negative slope clamps to the mean", near(flat.get("m/a")!, flat.get("m/new")!), `${flat.get("m/a")} ${flat.get("m/new")}`);

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
