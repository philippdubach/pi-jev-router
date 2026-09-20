// Selector — run: node --experimental-strip-types tests/selector.test.ts
import { selectModel, feasible, FALLBACK_MODELS, PROFILE_WEIGHTS, PROVEN_RUNS } from "../src/selector.ts";
import type { CatalogModel } from "../src/catalog.ts";
import type { EvidenceIndex } from "../src/evidence.ts";
import type { TaskEnvelope } from "../src/task-envelope.ts";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(ok ? "PASS" : "FAIL", name);
  if (!ok) failed++;
};

const model = (id: string, over: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  contextLength: 1000000,
  promptPrice: 0.000002,
  completionPrice: 0.00001,
  supportsTools: true,
  supportsReasoning: true,
  inputModalities: ["text", "image"],
  expiresAt: null,
  aa: { intelligence: 38.2, coding: 71.5, agentic: 43.6 },
  ...over,
});

const env = (over: Partial<TaskEnvelope["facts"]> = {}): TaskEnvelope => ({
  taskId: "t-1",
  role: "implementer",
  objective: "Implement an LRU cache",
  acceptanceCriteria: [],
  relevantContext: "",
  facts: { hasImages: false, estimatedContextTokens: 1000, requiredTools: [], attempt: 0, priorFailureKinds: [], ...over },
  policyRef: "policy@v2",
});

const answers = (complexity: number, risk: number) => ({
  ok: true, requestedModel: "j", resolvedModel: "j", latencyMs: 1,
  answers: {
    category: { id: "category", type: "choice" as const, value: "implementation" },
    complexity: { id: "complexity", type: "score" as const, value: complexity },
    risk: { id: "risk", type: "score" as const, value: risk },
  },
});

// --- feasibility ---
check("rejects no tool support", !feasible(model("x", { supportsTools: false }), env(), 0, "code", {}));
check("rejects small context", !feasible(model("x", { contextLength: 100 }), env({ estimatedContextTokens: 1000 }), 0, "code", {}));
check("accepts ample context", feasible(model("x"), env({ estimatedContextTokens: 1000 }), 0, "code", {}));
check("rejects expired", !feasible(model("x", { expiresAt: 1 }), env(), 0, "code", {}));
check("rejects text-only when images present", !feasible(model("x", { inputModalities: ["text"] }), env({ hasImages: true }), 0, "code", {}));
check("accepts image model when images present", feasible(model("x"), env({ hasImages: true }), 0, "code", {}));
check("rejects no reasoning for code", !feasible(model("x", { supportsReasoning: false }), env(), 0, "code", {}));
check("allows no reasoning for writing", feasible(model("x", { supportsReasoning: false }), env(), 0, "writing", {}));
check("rejects a negative price sentinel", !feasible(model("openrouter/auto", { promptPrice: -1 }), env(), 0, "code", {}));
check("rejects a batch endpoint", !feasible(model("x:batch"), env(), 0, "code", {}));
check("rejects a free endpoint", !feasible(model("x:free"), env(), 0, "code", {}));

// --- proven gate ---
const unproven: EvidenceIndex = {};
const proven: EvidenceIndex = { "x": { code: { runs: PROVEN_RUNS, passes: PROVEN_RUNS, meanCostUsd: 0.05, meanLatencyMs: 900 } } };
check("high risk rejects unproven", !feasible(model("x"), env(), 2, "code", unproven));
check("high risk accepts proven", feasible(model("x"), env(), 2, "code", proven));
check("low risk accepts unproven", feasible(model("x"), env(), 1, "code", unproven));

// --- selection ---
const catalog = [
  model("cheap/flash", { promptPrice: 0.00000075, completionPrice: 0.00000375, aa: { intelligence: 40.9, coding: 76.3, agentic: 40.2 } }),
  model("mid/sonnet"),
  model("dear/fable", { promptPrice: 0.00001, completionPrice: 0.00005, aa: { intelligence: 53.4, coding: 81.6, agentic: 57.9 } }),
];

const writing = selectModel(env(), answers(1, 0) as any, catalog, {}, "writing");
check("writing route is cheap", writing.modelId === "cheap/flash");
check("writing reason", writing.reason === "frontier_tangency");
check("reports candidate count", writing.candidateCount === 3);
check("reports frontier", Array.isArray(writing.frontier) && writing.frontier.length >= 1);

const planning = selectModel(env(), answers(3, 0) as any, catalog, {}, "planning");
check("planning route favours quality", planning.modelId === "dear/fable");

// An empty catalog leaves no frontier to compute, so the fallback table answers.
const noCatalog = selectModel(env(), answers(1, 0) as any, [], {}, "code");
check("empty catalog falls back", noCatalog.modelId === FALLBACK_MODELS.code && noCatalog.reason === "catalog_unavailable");

// --- relaxation ---
const risky = selectModel(env(), answers(1, 3) as any, catalog, {}, "code");
check("relaxes proven gate when nothing qualifies", risky.reason === "relaxed_proven_gate");
check("relaxation still returns a model", risky.modelId.length > 0);

// --- classifier down ---
const down = selectModel(env(), { ok: false, classifierUnavailable: true, answers: {}, requestedModel: "j", resolvedModel: "j", latencyMs: 0 } as any, catalog, {}, "code");
check("classifier down still selects", down.modelId.length > 0);
check("classifier down reason", down.reason === "classifier_unavailable");

// --- knee selection ---
// Three non-dominated models: the middle one is the knee, so it is picked with
// no weights at all. The pick follows the live frontier.
const kneeCatalog = [
  model("a/cheap", { promptPrice: 0.0000003, completionPrice: 0.000001, aa: { intelligence: 30, coding: 50, agentic: 30 } }),
  model("b/mid", { promptPrice: 0.000001, completionPrice: 0.000005, aa: { intelligence: 40, coding: 65, agentic: 40 } }),
  model("c/strong", { promptPrice: 0.00001, completionPrice: 0.00005, aa: { intelligence: 53, coding: 82, agentic: 58 } }),
];
const kneePick = selectModel(env(), answers(1, 0) as any, kneeCatalog, {}, "code");
check("three-point frontier picks the knee", kneePick.modelId === "b/mid");
check("knee reason", kneePick.reason === "frontier_knee");

// --- weights table shape ---
check("writing is the most cost averse", PROFILE_WEIGHTS.writing.lambda > PROFILE_WEIGHTS.code.lambda);
check("planning is the least cost averse", PROFILE_WEIGHTS.planning.lambda < PROFILE_WEIGHTS.code.lambda);

process.exit(failed ? 1 : 0);
