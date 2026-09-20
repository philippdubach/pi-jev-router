# Dynamic model selection over the OpenRouter catalog

Date: 2026-09-20
Status: approved for planning

## Goal

Replace the hardcoded model tables in `src/selector.ts` with a selector that
ranks the full OpenRouter catalog for each task. The selector computes a Pareto
frontier over quality, cost, and latency. It then picks one point on that
frontier using per-role weights.

## Background

The current selector does not select. `recommendByRole` accepts `answers` and
`policy` and reads neither:

```ts
const modelId = PROFILE_MODELS[profile][workKind];
```

Three work kinds map to three fixed model IDs. `DEFAULT_POLICY.allowlist` holds
three more. Of Jev's five questions, only `category` reaches the decision.
`complexity`, `risk`, `brief`, and `decompose` are computed, validated, then
discarded. They survive only in a log line at `extensions/router.ts:312`.

The scoring path that does read `complexity` and `risk` is `recommend()`. It is
reachable only when `workKind === "other"` or the classifier fails.

Two consequences appear in `eval/results/benchmark-2026-09-20T13-36-36-755Z.json`:

- Every code task routes to `openrouter/pareto-code` regardless of difficulty.
- `min_coding_score` is never set anywhere in the repository. OpenRouter then
  defaults to its high tier.

The three code tasks cost $0.706, $0.706, and $0.740 through that route while
their elapsed times varied. Fixed Sonnet cost $0.079, $0.089, and $0.109 on the
same tasks and passed all three. Total run cost was $2.34022445 routed against
$0.5547933 fixed.

## Decisions

1. Quality comes from own eval history, backed by the benchmark data already
   present in the catalog, backed by an optimistic prior.
2. The objective is a weighted utility over quality, cost, and latency.
3. Hard filters come from catalog fields. A proven gate gives risky work to
   models with a track record.
4. The selector computes a discrete Pareto frontier, then takes the tangency
   point.

## Data sources

### Catalog

`GET https://openrouter.ai/api/v1/models` returns 446 models and 738 KB.
Verified fields per model:

| Field | Use |
|---|---|
| `id` | model identifier |
| `context_length` | feasibility |
| `pricing.prompt`, `pricing.completion` | cost prior |
| `supported_parameters` | feasibility: `tools`, `reasoning` |
| `architecture.input_modalities` | feasibility: `text` |
| `expiration_date` | feasibility |
| `benchmarks.artificial_analysis` | quality prior |

`benchmarks.artificial_analysis` supplies `intelligence_index`, `coding_index`,
and `agentic_index`. 187 of 446 models carry it. 378 models support `tools`.
314 support `reasoning`.

The catalog is cached at `~/.pi/agent/cache/openrouter-models.json`. The time to
live is 12 hours. A failed refresh uses the cached copy and logs the staleness.

### Own evidence

`eval/results/benchmark-*.json` supplies `results[]` with `modelUsed`,
`passed`, `costUsd`, `latencyMs`, and `taskId`. The aggregator groups these by
model and work kind. It produces `runs`, `passes`, `meanCostUsd`, and
`meanLatencyMs`.

## Estimators

Each estimator blends evidence with a prior. The blend weight rises with the
number of observed runs.

```
w(n) = n / (n + 5)
```

### Quality

```
q(m,k) = w(n) * q_obs(m,k) + (1 - w(n)) * q_prior(m,k)

q_obs(m,k)   = (passes + 1) / (runs + 2)
q_prior(m,k) = normalised artificial_analysis index, by work kind
```

The index depends on the work kind:

| Work kind | Index |
|---|---|
| planning | `intelligence_index` |
| code | `coding_index` |
| writing | `intelligence_index` |
| other | `agentic_index` |

Each index is min-max normalised across the models that carry it. The three
indices use different scales, so each is normalised within its own family.

A model with no `artificial_analysis` entry receives the 60th percentile of the
normalised distribution for that index. This prior is deliberately optimistic.
An unmeasured model must be able to win low-risk work, because that is how it
earns evidence.

### Cost

The eval data shows why a naive price estimate fails. The LRU task logged 8
input tokens and 1276 output tokens, with 65513 cache-read and 21379
cache-write tokens. Cache traffic dominates the bill.

```
c(m,env) = w(n) * meanCostUsd(m,k) + (1 - w(n)) * c_est(m,env)

c_est(m,env) = turns * (pricing.prompt * env.facts.estimatedContextTokens
                        + pricing.completion * estOutputTokens)
turns            defaults to 4
estOutputTokens  defaults to 1500
```

`c_est` is coarse by design. Evidence replaces it as runs accumulate.

### Latency

```
t(m,k) = w(n) * meanLatencyMs(m,k) + (1 - w(n)) * t_prior(k)
t_prior(k) = median meanLatencyMs across models observed for kind k
```

The catalog carries no latency data. If fewer than two models have latency
observations for the work kind, the selector sets every `t` to zero and logs
`latency_signal_absent`. The latency term then has no effect. The selector must
not invent a latency number it cannot source.

## Feasibility filter

```
feasible(m, env, risk, k) =
     m.context_length >= env.facts.estimatedContextTokens * 1.3
  && m.supported_parameters.includes("tools")
  && (!needsReasoning(k) || m.supported_parameters.includes("reasoning"))
  && m.architecture.input_modalities.includes("text")
  && (!env.facts.hasImages || m.architecture.input_modalities.includes("image"))
  && !expired(m)
  && (risk < 2 || runs(m, k) >= 3)
```

Helper definitions:

```
needsReasoning(k) = k === "planning" || k === "code"
expired(m)        = m.expiration_date != null
                    && Date.parse(m.expiration_date) <= Date.now()
runs(m, k)        = evidence[m.id]?.[k]?.runs ?? 0
```

`env.facts.requiredTools` does not filter the catalog. OpenRouter advertises
tool support as a capability, not as a named tool list. The `tools` parameter
check covers it.

The last clause is the proven gate. A model with fewer than three recorded runs
for the work kind cannot take a task whose risk score is 2 or higher.

## Pareto frontier

A model `a` dominates a model `b` when `a` is no worse on all three objectives
and strictly better on at least one:

```
dominates(a,b) =
     q(a) >= q(b) && c(a) <= c(b) && t(a) <= t(b)
  && (q(a) > q(b) || c(a) < c(b) || t(a) < t(b))
```

The frontier `F` is the non-dominated subset of the feasible set. The
comparison is O(n squared). With n near 200 this is about 40000 comparisons and
costs no measurable time.

## Tangency selection

Each objective is min-max normalised across `F`, not across the catalog. The
frontier is the relevant comparison set.

```
u(m) = qhat(m) - lambda * chat(m) - mu * that(m)
pick = argmax over F of u(m)
```

The argmax of a linear scalarisation always lies on the frontier. Computing `F`
first does not change the winner for a given lambda. It shrinks the sort set,
supplies a loggable frontier, and leaves room for a different selection rule
later.

Linear weights reach only the convex hull of `F`. A model inside a concave
region of the frontier cannot win for any lambda. This is accepted.

## Profiles

`PROFILE_MODELS` is removed. Profiles become weights:

```ts
export type RouterProfile = "frontier" | "pareto_code" | "empirical_cost";
export interface Weights { lambda: number; mu: number }

export const PROFILE_WEIGHTS: Record<WorkKind, Weights> = {
  planning: { lambda: 0.15, mu: 0.05 },
  code:     { lambda: 0.45, mu: 0.20 },
  writing:  { lambda: 0.80, mu: 0.50 },
  other:    { lambda: 0.50, mu: 0.25 },
};
```

Only the `frontier` profile uses these weights, so the table is keyed by work
kind alone. `pareto_code` and `empirical_cost` remain as pinned profiles. They
bypass the frontier and return their fixed model from a small pinned table.
They exist so `eval/` can measure the new profile against both.

`frontier` becomes the default profile. Shadow mode remains the default mode,
so the router recommends without switching until the operator runs
`/router auto`.

## Modules

| File | Status | Responsibility |
|---|---|---|
| `src/catalog.ts` | new | fetch, cache, normalise the catalog |
| `src/evidence.ts` | new | aggregate `eval/results` into per-model stats |
| `src/frontier.ts` | new | dominance, frontier, tangency |
| `src/selector.ts` | modify | `selectModel`, profile weights |
| `src/dispatch.ts` | modify | call site at line 102 |
| `extensions/router.ts` | modify | call site at line 125, `/router frontier` |
| `eval/runner.ts` | modify | call site at line 81 |

`src/selector.ts` stays pure. It performs no network call and reads no file.
`selectModel` receives the catalog and the evidence as arguments. `src/catalog.ts`
owns the fetch and the cache.

Removed from `src/selector.ts`: `PROFILE_MODELS`, `ROLE_MODELS`, `recommend`,
`recommendByRole`, and the `allowlist`, `tierMapping`, and `riskFloor` fields of
`Policy`. The three model IDs in the old `allowlist` move to `BOOTSTRAP_MODELS`
in `src/catalog.ts`. `resolveWorkKind` and `ROLE_THINKING` are unchanged.

## Interface

```ts
export function selectModel(
  env: TaskEnvelope,
  classification: ClassificationResult,
  catalog: CatalogModel[],
  evidence: EvidenceIndex,
  profile: RouterProfile,
): Recommendation;
```

```ts
export interface ModelStats { runs: number; passes: number; meanCostUsd: number; meanLatencyMs: number }
export type EvidenceIndex = Record<string, Partial<Record<WorkKind, ModelStats>>>;
```

`Recommendation` gains `q`, `cEst`, `tEst`, `candidateCount`, `frontier`, and
`lambda` and `mu`. `reason` gains `frontier_tangency`, `catalog_unavailable`,
`relaxed_proven_gate`, and `relaxed_reasoning`.

## Failure modes

| Condition | Behaviour |
|---|---|
| Catalog fetch fails, cache present | use cache, log staleness |
| Catalog fetch fails, no cache | use bootstrap list, `reason: catalog_unavailable` |
| Classifier unavailable | current fallback to `fallbackModelId`, unchanged |
| Frontier empty after filters | relax in order, log which relaxation fired |

The bootstrap list holds the three models currently in `DEFAULT_POLICY.allowlist`.
It is a failure path, not the routing path.

Relaxation order when `F` is empty:

1. Drop the proven gate when `risk < 2`.
2. Drop the reasoning requirement.
3. Use the bootstrap list.

## Observability

The ledger records every routing decision. Each record gains `candidateCount`,
`frontierSize`, `q`, `cEst`, `tEst`, `lambda`, `mu`, and the relaxation reason.

`/router frontier` prints the frontier for the last decision. It shows each
member with its quality, cost, latency, and utility, and marks the winner.

## Testing

New tests:

- `tests/frontier.test.ts` — dominance on fixtures, including ties, a single
  dominating model, and an all-non-dominated set.
- `tests/catalog.test.ts` — parse a recorded catalog fixture, honour the time to
  live, survive a malformed response.
- `tests/evidence.test.ts` — aggregate a recorded `eval/results` fixture into
  expected per-model statistics.

Updated tests:

- `tests/selector.test.ts` — `selectModel` with an injected catalog and evidence.
- `tests/role-routing.test.ts` — profiles carry weights, not model IDs.

The three commands in `AGENTS.md` must pass before any commit.

## Rule change

`AGENTS.md` hard rule 5 currently reads:

> Keep the model allowlist in `src/selector.ts` explicit. Never route to an
> unlisted model.

This design reverses that rule. The replacement:

> 5. Route only to models the catalog lists as feasible for the task. A model
>    with fewer than three recorded runs for the work kind cannot take a task
>    with risk 2 or higher. The bootstrap list applies only when the catalog is
>    unavailable.

Hard rules 1, 2, 3, 4, 6, 7, and 8 are unchanged.

## Out of scope

- Randomised routing across models. A continuous convex program over a
  distribution is the literal portfolio analogy. It makes single runs
  non-reproducible and needs task volume this project does not have.
- Live latency probing.
- A dashboard, a server, or an MCP layer. `AGENTS.md` forbids these.
- Tuning lambda and mu beyond the starting values. The eval harness tunes them
  against measured runs.
- Retry escalation. `env.facts.attempt` and `env.facts.priorFailureKinds` are
  carried by the envelope and ignored by this design. Raising the effective risk
  on a retry is a one-clause change. It is deferred so this change is measured
  on its own.
