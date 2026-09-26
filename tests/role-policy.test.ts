// Role policy — run: node --experimental-strip-types tests/role-policy.test.ts
import { selectModel, PLANNING_MIN_INTELLIGENCE_PERCENTILE } from "../src/selector.ts";
import type { CatalogModel } from "../src/catalog.ts";
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
// Size the catalog from the threshold, so the two top models clear it and
// z-ai/cheap-flash (fourth from the top) does not, whatever value Step 1 sets.
const total = Math.max(25, Math.ceil(2.5 / (1 - PLANNING_MIN_INTELLIGENCE_PERCENTILE)) + 1);
const filler = Array.from({ length: total - 5 }, (_, i) => model(`f/m${i}`, 1e-7 * (1 + i / total), 10 + (26 * i) / total));
const catalog = [
  ...filler,
  model("z-ai/cheap-flash", 1e-7, 44),
  model("anthropic/top-a", 4e-6, 57),
  model("anthropic/top-b", 1e-5, 58),
  model("openai/fast-writer", 2e-7, 37),
  model("openai/big-writer", 1e-5, 52),
];
const env: TaskEnvelope = {
  taskId: "t", role: "direct", objective: "x", acceptanceCriteria: [], relevantContext: "",
  facts: { hasImages: false, estimatedContextTokens: 5000, requiredTools: [], attempt: 0, priorFailureKinds: [] }, policyRef: "p",
};
const cls = (cx: number) => ({ ok: true, requestedModel: "j", resolvedModel: "j", latencyMs: 1,
  answers: { complexity: { id: "complexity", type: "score" as const, value: cx }, risk: { id: "risk", type: "score" as const, value: 0.5 } } });

const plan = selectModel(env, cls(1.5), catalog, {}, "planning");
check("planning goes to a top-tier model", plan.modelId.startsWith("anthropic/top-"), plan.modelId);
const w = selectModel(env, cls(1), catalog, {}, "writing");
check("writing goes to an OpenAI model", w.modelId.startsWith("openai/"), w.modelId);
const noOpenAI = catalog.filter((m) => !m.id.startsWith("openai/"));
const w2 = selectModel(env, cls(1), noOpenAI, {}, "writing");
check("no OpenAI model: writing still routes", w2.modelId !== "" && w2.reason === "relaxed_role_policy", `${w2.modelId} ${w2.reason}`);

// Complexity must move the pick somewhere across the range.
const picks = new Set([0, 1, 2, 3].map((cx) => selectModel(env, cls(cx), catalog, {}, "planning").modelId));
check("complexity changes the planning pick", picks.size > 1, [...picks].join(","));
const easy = selectModel(env, cls(0), catalog, {}, "code");
const hard = selectModel(env, cls(3), catalog, {}, "code");
check("hard code costs at least as much as easy code", (hard.cEst ?? 0) >= (easy.cEst ?? 0), `${easy.modelId} ${hard.modelId}`);
process.exit(failed ? 1 : 0);
