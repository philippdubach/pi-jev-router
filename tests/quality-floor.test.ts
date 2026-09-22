// Demonstrated-failure gate — run: node --experimental-strip-types tests/quality-floor.test.ts
import { feasible, qualityPrior, posteriorQuality, QUALITY_FLOOR } from "../src/selector.ts";
import type { EvidenceIndex } from "../src/evidence.ts";
import type { CatalogModel } from "../src/catalog.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(cond ? "PASS" : "FAIL", name, cond ? "" : detail);
  if (!cond) failed++;
}

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id, promptPrice: 1e-7, completionPrice: 2e-7, contextLength: 200000,
    supportsTools: true, supportsReasoning: true, inputModalities: ["text"],
    expiresAt: null, aa: { coding: 50, intelligence: 50, agentic: 50 }, ...extra,
  } as CatalogModel;
}

const env: any = {
  taskId: "t", role: "direct", objective: "o", acceptanceCriteria: [], relevantContext: "",
  facts: { hasImages: false, estimatedContextTokens: 1000, requiredTools: [], attempt: 0, priorFailureKinds: [] },
  policyRef: "v3",
};

const catalog = [model("good/one"), model("bad/one"), model("untested/one")];
const priors = qualityPrior(catalog, "writing");
const evidence: EvidenceIndex = {
  "good/one": { writing: { runs: 2, passes: 2, meanCostUsd: 0.01, meanLatencyMs: 5000 } },
  "bad/one": { writing: { runs: 2, passes: 0, meanCostUsd: 0.0001, meanLatencyMs: 4000 } },
};

const opts = { priors };
check("a model with a clean record stays eligible", feasible(catalog[0], env, 0, "writing", evidence, opts));
check("a model that failed its runs is excluded", !feasible(catalog[1], env, 0, "writing", evidence, opts));
check("an untested model is not blocked by the floor", feasible(catalog[2], env, 0, "writing", evidence, opts));

check(
  "the floor can be relaxed as a last resort",
  feasible(catalog[1], env, 0, "writing", evidence, { ...opts, ignoreQualityFloor: true }),
);

// The gate must key on the posterior, not the raw rate, so one unlucky run
// against a strong prior does not eliminate a model outright.
const oneMiss: EvidenceIndex = { "good/one": { writing: { runs: 1, passes: 0, meanCostUsd: 0.01, meanLatencyMs: 5000 } } };
const prior = priors.get("good/one") ?? 0.5;
const post = posteriorQuality(0, 1, prior);
check("single failure is judged on the posterior", Math.abs(post - (2 * prior) / 3) < 1e-9, String(post));
check(
  "gate agrees with the posterior",
  feasible(catalog[0], env, 0, "writing", oneMiss, opts) === post >= QUALITY_FLOOR,
);

check("floor sits below a clean record and above a failed one",
  posteriorQuality(2, 2, 0.75) > QUALITY_FLOOR && posteriorQuality(0, 2, 0.75) < QUALITY_FLOOR);

process.exit(failed ? 1 : 0);
