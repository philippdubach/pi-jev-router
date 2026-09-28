// Role policy — run: node --experimental-strip-types tests/role-policy.test.ts
import { selectModel, roleEligible, complexityScale, PROFILE_WEIGHTS, PLANNING_MIN_INTELLIGENCE, PLANNING_MEASURED_MIN_INTELLIGENCE, PLANNING_UNINDEXED_MIN_RUNS, WRITING_MIN_ELO } from "../src/selector.ts";
import { WRITING_ELO } from "../src/writing-prior.ts";
import type { CatalogModel } from "../src/catalog.ts";
import type { EvidenceIndex } from "../src/evidence.ts";
import type { TaskEnvelope } from "../src/task-envelope.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
  if (!ok) failed++;
};
const model = (id: string, price: number, intelligence: number): CatalogModel => ({
  id, contextLength: 1e6, promptPrice: price, completionPrice: price * 5, supportsTools: true,
  supportsReasoning: true, inputModalities: ["text"], expiresAt: null,
  aa: { intelligence, coding: intelligence * 1.6, agentic: intelligence },
});

// The fixture must sit on the right side of the real lines, or the checks
// below test nothing.
check("fixture: top models clear the planning line", 57 >= PLANNING_MIN_INTELLIGENCE && 44 < PLANNING_MIN_INTELLIGENCE);
check("fixture: luna and astra are rated above the writing line",
  (WRITING_ELO["openai/gpt-5.6-luna"] ?? 0) >= WRITING_MIN_ELO && (WRITING_ELO["openai/gpt-6-astra"] ?? 0) >= WRITING_MIN_ELO);
check("fixture: gpt-5-nano and gpt-6-sol are unrated",
  WRITING_ELO["openai/gpt-5-nano"] === undefined && WRITING_ELO["openai/gpt-6-sol"] === undefined);

const catalog = [
  model("f/small", 5e-8, 20),
  model("f/mid", 8e-8, 32),
  model("z-ai/cheap-flash", 1e-7, 44),
  model("anthropic/top-a", 4e-6, 57),
  model("anthropic/top-b", 1e-5, 58),
  model("openai/gpt-5-nano", 5e-8, 30),
  model("openai/gpt-5.6-luna", 2e-7, 40),
  model("openai/gpt-6-astra", 1e-5, 52.7),
];
const env: TaskEnvelope = {
  taskId: "t", role: "direct", objective: "x", acceptanceCriteria: [], relevantContext: "",
  facts: { hasImages: false, estimatedContextTokens: 5000, requiredTools: [], attempt: 0, priorFailureKinds: [] }, policyRef: "p",
};
const cls = (cx: number) => ({ ok: true, requestedModel: "j", resolvedModel: "j", latencyMs: 1,
  answers: { complexity: { id: "complexity", type: "score" as const, value: cx }, risk: { id: "risk", type: "score" as const, value: 0.5 } } });

// --- planning ---
const plan = selectModel(env, cls(1.5), catalog, {}, "planning");
check("planning goes to a top-tier model", plan.modelId.startsWith("anthropic/top-") || plan.modelId === "openai/gpt-6-astra", plan.modelId);
// Complexity must move the pick somewhere across the range.
const picks = new Set([0, 1, 2, 3].map((cx) => selectModel(env, cls(cx), catalog, {}, "planning").modelId));
check("complexity changes the planning pick", picks.size > 1, [...picks].join(","));

// --- writing ---
const w = selectModel(env, cls(1), catalog, {}, "writing");
check("writing goes to a rated model, not gpt-5-nano",
  w.modelId.startsWith("openai/") && w.modelId !== "openai/gpt-5-nano" && w.reason === "frontier_tangency", `${w.modelId} ${w.reason}`);

// An unrated model becomes eligible once it has measured writing runs.
const solOnly = [...catalog.filter((m) => !m.id.startsWith("openai/")), model("openai/gpt-6-sol", 2e-6, 47.5)];
const solEvidence: EvidenceIndex = { "openai/gpt-6-sol": { writing: { runs: 4, passes: 4, meanCostUsd: 0.01, meanLatencyMs: 5000 } } };
const ws = selectModel(env, cls(1), solOnly, solEvidence, "writing");
check("unrated model with measured runs is eligible", ws.modelId === "openai/gpt-6-sol" && ws.reason === "frontier_tangency", `${ws.modelId} ${ws.reason}`);
const solThin: EvidenceIndex = { "openai/gpt-6-sol": { writing: { runs: 2, passes: 2, meanCostUsd: 0.01, meanLatencyMs: 5000 } } };
const wt = selectModel(env, cls(1), solOnly, solThin, "writing");
check("unrated model with too few runs is not eligible", wt.reason === "relaxed_role_policy", `${wt.modelId} ${wt.reason}`);

const noRated = catalog.filter((m) => !m.id.startsWith("openai/"));
const w2 = selectModel(env, cls(1), noRated, {}, "writing");
check("no rated model: writing still routes", w2.modelId !== "" && w2.reason === "relaxed_role_policy", `${w2.modelId} ${w2.reason}`);

// The vendor is not a rule (28 September 2026). Any model with a writing
// Elo at or above the line is eligible.
const fable = [...noRated, model("anthropic/claude-fable-5.1", 2e-6, 53.4)];
const wf = selectModel(env, cls(1), fable, {}, "writing");
check("a rated non-OpenAI model is eligible for writing", wf.modelId === "anthropic/claude-fable-5.1" && wf.reason === "frontier_tangency", `${wf.modelId} ${wf.reason}`);

// --- code ---
const easy = selectModel(env, cls(0), catalog, {}, "code");
const hard = selectModel(env, cls(3), catalog, {}, "code");
check("hard code costs at least as much as easy code", (hard.cEst ?? 0) >= (easy.cEst ?? 0), `${easy.modelId} ${hard.modelId}`);
// --- planning: a second, lower line for measured planners (26 Sep decision) ---
check("fixture: sol sits between the two planning lines",
  47.5 >= PLANNING_MEASURED_MIN_INTELLIGENCE && 47.5 < PLANNING_MIN_INTELLIGENCE && 41.8 < PLANNING_MEASURED_MIN_INTELLIGENCE);
const sol = model("openai/sol", 2e-6, 47.5);
const flash = model("z-ai/flash", 1e-7, 41.8);
const runs = (n: number, p: number) => ({ runs: n, passes: p, meanCostUsd: 0.05, meanLatencyMs: 30000 });
const measuredPlanners: EvidenceIndex = { "openai/sol": { planning: runs(4, 4) }, "z-ai/flash": { planning: runs(5, 5) } };
check("a measured planner above the second line is eligible", roleEligible(sol, "planning", measuredPlanners));
check("a measured planner below the second line stays out", !roleEligible(flash, "planning", measuredPlanners));
check("an unmeasured model between the lines stays out", !roleEligible(sol, "planning", {}));
check("two planning runs are not enough", !roleEligible(sol, "planning", { "openai/sol": { planning: runs(2, 2) } }));

// --- hard code weighs cost like planning (26 Sep decision) ---
const codeCat = [model("c/weak", 5e-8, 10), model("c/cheap", 1e-7, 50), model("c/strong", 3e-5, 58)];
const codeEasy = selectModel(env, cls(1), codeCat, {}, "code");
const codeHard = selectModel(env, cls(2.5), codeCat, {}, "code");
check("hard code uses the planning cost weight",
  codeHard.lambda === PROFILE_WEIGHTS.planning.lambda * complexityScale(2.5), String(codeHard.lambda));
check("easy code keeps the code cost weight",
  codeEasy.lambda === PROFILE_WEIGHTS.code.lambda * complexityScale(1), String(codeEasy.lambda));
check("hard code buys the strong model where easy code takes the cheap one",
  codeEasy.modelId === "c/cheap" && codeHard.modelId === "c/strong", `${codeEasy.modelId} ${codeHard.modelId}`);
// --- planning: a model with no intelligence index (27 Sep decision) ---
const unindexed: CatalogModel = { ...model("fireworks/unindexed", 3e-6, 0), aa: null };
const zeroIndex = model("ling/zero-index", 1e-7, 0);
const clean = runs(PLANNING_UNINDEXED_MIN_RUNS, PLANNING_UNINDEXED_MIN_RUNS);
check("an index-less model with a clean planning record is eligible",
  roleEligible(unindexed, "planning", { "fireworks/unindexed": { planning: clean } }));
check("an index of 0 counts as no index",
  roleEligible(zeroIndex, "planning", { "ling/zero-index": { planning: clean } }));
check("one failed planning run keeps an index-less model out",
  !roleEligible(unindexed, "planning", { "fireworks/unindexed": { planning: runs(5, 4) } }));
check("too few runs keep an index-less model out",
  !roleEligible(unindexed, "planning", { "fireworks/unindexed": { planning: runs(PLANNING_UNINDEXED_MIN_RUNS - 1, PLANNING_UNINDEXED_MIN_RUNS - 1) } }));
check("an unmeasured index-less model stays out", !roleEligible(unindexed, "planning", {}));
check("an indexed model below the measured line still stays out on a clean record",
  !roleEligible(flash, "planning", { "z-ai/flash": { planning: runs(8, 8) } }));
process.exit(failed ? 1 : 0);
