// Every classifier answer must influence the pick — run: node --experimental-strip-types tests/classifier-signals.test.ts
import { selectModel, complexityScale, BRIEF_ABSTAIN_CONFIDENCE, DECOMPOSE_HINT_THRESHOLD } from "../src/selector.ts";
import type { CatalogModel } from "../src/catalog.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(cond ? "PASS" : "FAIL", name, cond ? "" : detail);
  if (!cond) failed++;
}

function model(id: string, price: number, coding: number): CatalogModel {
  return {
    id, promptPrice: price, completionPrice: price * 3, contextLength: 200000,
    supportsTools: true, supportsReasoning: true, inputModalities: ["text"],
    expiresAt: null, aa: { coding, intelligence: coding, agentic: coding },
  } as CatalogModel;
}

// A frontier with no knee (concave), so the pick comes from tangency and
// therefore responds to lambda.
const catalog = [
  model("cheap/a", 1e-8, 60),
  model("mid/b", 1e-7, 80),
  model("dear/c", 1e-6, 95),
];
const env: any = {
  taskId: "t", role: "direct", objective: "o", acceptanceCriteria: [], relevantContext: "",
  facts: { hasImages: false, estimatedContextTokens: 5000, requiredTools: [], attempt: 0, priorFailureKinds: [] },
  policyRef: "v4",
};
const cls = (extra: Record<string, any>) => ({ ok: true, answers: { category: { value: "implementation" }, risk: { value: 0.5 }, ...extra } }) as any;

// --- complexityScale ---
check("complexity 0 is 1.5x cost averse", complexityScale(0) === 1.5);
check("complexity 3 is 0.5x cost averse", complexityScale(3) === 0.5);
check("complexity 1.5 is neutral", Math.abs(complexityScale(1.5) - 1.0) < 1e-9);
check("complexity clamps high", complexityScale(9) === 0.5);
check("complexity clamps low", complexityScale(-2) === 1.5);
check("non-finite complexity is neutral-ish", complexityScale(NaN) === 1.5 - 1 / 3);

// --- complexity reaches the pick ---
const easy = selectModel(env, cls({ complexity: { value: 0.2 } }), catalog, {}, "code");
const hard = selectModel(env, cls({ complexity: { value: 2.9 } }), catalog, {}, "code");
check("easy task is more cost averse", (easy.lambda ?? 0) > (hard.lambda ?? 0), `${easy.lambda} vs ${hard.lambda}`);
check("lambda is reported scaled", easy.lambda !== undefined && easy.lambda !== 0.45);
const rank = (id: string) => catalog.findIndex((m) => m.id === id);
check("a hard task never picks a cheaper model than an easy one", rank(hard.modelId) >= rank(easy.modelId), `${easy.modelId} vs ${hard.modelId}`);

// --- brief abstain ---
const notReady = selectModel(env, cls({ complexity: { value: 1 }, brief: { value: "clarify", confidence: 0.9 } }), catalog, {}, "code");
check("confident clarify withholds the pick", notReady.reason === "brief_unclear");
check("withheld pick carries no model", notReady.modelId === "");
check("withheld pick reports the confidence", notReady.briefConfidence === 0.9);

const unsure = selectModel(env, cls({ complexity: { value: 1 }, brief: { value: "clarify", confidence: 0.4 } }), catalog, {}, "code");
check("low-confidence clarify still routes", unsure.reason !== "brief_unclear" && unsure.modelId !== "");

const ready = selectModel(env, cls({ complexity: { value: 1 }, brief: { value: "sufficient", confidence: 0.95 } }), catalog, {}, "code");
check("sufficient brief routes", ready.reason !== "brief_unclear");

const down = selectModel(env, { ok: false, classifierUnavailable: true, answers: { brief: { value: "clarify", confidence: 0.99 } } } as any, catalog, {}, "code");
check("classifier down never abstains on a stale brief", down.reason !== "brief_unclear" && down.modelId !== "");

check("abstain threshold is exported", BRIEF_ABSTAIN_CONFIDENCE === 0.7);
check("decompose threshold is exported", DECOMPOSE_HINT_THRESHOLD === 0.7);

process.exit(failed ? 1 : 0);
