# pi-jev-router: a minimal Pareto-optimal OpenRouter model router for pi, based on Jev

Jev-classified model routing for pi.

## Model rules

The router applies the role policy as an eligibility filter, then picks
inside the eligible set by a weighted value function.

- **Planning** — only models with an Artificial Analysis intelligence index
  at or above 48.5 are eligible.
- **Writing** — only OpenAI models are eligible, and only if they have a
  measured writing Elo of at least 1760 or at least 3 measured writing runs.
- **Code** — no role restriction. Every feasible model is eligible.

Inside the eligible set, the router computes a Pareto frontier over quality,
cost and latency, then scores each frontier member with a weighted value
function: quality minus cost and latency, scaled by role and by task
complexity (harder tasks weigh cost less). That score picks the model. The
frontier's knee point — the member farthest from the chord joining the
cheapest and dearest models — is still computed and reported, but only as a
diagnostic; it no longer makes the pick, because it ignores the role and
complexity weights.

Bare continuations ("continue", "go on", "keep going", "yes", …) keep the
current model and skip the classifier call. A continuation after an abstain
or a pin classifies normally instead of keeping an empty pick.

Hard tasks (complexity at or above 2) read a hard-suite evidence cell instead
of the overall one, once enough hard runs exist. Quality priors — the
Artificial Analysis rank for an unmeasured model, EQ-Bench Elo for writing —
are calibrated onto the same scale as the measured pass rate, so a measured
and an unmeasured model compare fairly.

Quality blends recorded runs from `eval/results` with the Artificial Analysis
index. Writing quality uses the EQ-Bench Creative Writing v3 Elo in
`src/writing-prior.ts` instead, because a general intelligence index says
nothing about prose. Cost is a per-task estimate from catalogue prices,
replaced by recorded mean cost as runs accumulate. Latency uses recorded means
when they exist.

There is one selection policy. `src/selector.ts` holds a small fallback table
for the case where the catalog cannot be fetched and no frontier exists.

Each ledger row records the loaded `routerVersion` and the `activeModel` that
ran. `/router status` compares the loaded version against the version on
disk and warns to restart pi when they differ. A long session also reloads
the catalog and the evidence periodically, instead of holding them fixed for
the life of the process.

Writing tasks get STE and Humanizer rules. Code tasks run unit tests.
Planning tasks get a structure check.

## Subscription routing

Off by default. The frontier picks the model; this only changes how that model
is reached.

```text
/router subscription openai-codex     route through a logged-in plan
/router subscription off              back to metered routes
/router subscription                  show status and cooldowns
```

A plan route is best effort. A ChatGPT account does not support every Codex
model, and a plan can hit its usage limit mid-session. Probed on 22 and 25
September: three Codex models were unsupported on this plan and the other
three were at their usage limit both times, so the route has not yet served
a request. Both refusals put the
route on a cooldown and fall back to the metered route: unsupported for 30
days, usage limit for an hour, anything else for ten minutes.

Anthropic is a different case. Pi lists the same price on both routes, and pi's
docs state that third-party harness usage draws from extra usage billed per
token rather than plan limits. Enabling it changes the invoice, not the cost.

## Commands

```text
/router           show status
/router shadow    recommend only (default)
/router auto      switch models per task
/router auto --dry-run N   switch for N tasks, then return to shadow with a summary
/router off       stop routing
/router frontier  show the frontier for the last decision
/router pin <id>  force a model
/router pin off   release the pin
/router budget <usd>
/router subscription <provider,...> | off
/router test      classify a sample task and show the pick
```

## Benchmarks

```bash
npm run bench                    # fixed baseline vs frontier router
npm run bench -- --all           # adds the pinned role arm as a third control
npm run bench -- --hard          # only the discriminating tasks
npm run bench -- --suite         # every task
npm run bench -- --models=a,b    # measure named models directly
```

The original five tasks were passed by every model tried, so their pass rates
carried no quality signal. `--hard` adds three tasks with a specific failure
mode: a cache stampede under concurrent misses, a rename that must reach a
barrel export and a string-keyed registry, and a runbook under hard
sentence-length and voice limits. Each verifier was checked against both the
starting state and a correct solution.

`--ceiling` adds three more, scored against tests the model never sees: the
visible suite is partial and a hidden suite checks the rest of the stated
specification, so a near-miss such as a truthiness merge or a strict-less-than
comparison fails.

Those tasks also carry a turn budget. A deterministic test suite is a feedback
loop, so correctness alone separates almost nothing: every model reached a
passing state on every code task. What differs is how many attempts it took,
and each attempt costs money and time. Exceeding the budget is a failure.

Measured over four models, code pass rates ran from 33% to 100% and the writing
task separated them again. `deepseek-v4-flash-0731` is the clearest case: it
solved every code task correctly but needed 13, 7 and 6 turns, so its posterior
fell below its catalog prior.

Five tasks, three code and two non-code, each in an isolated workspace with an
independent verifier. Last recorded run (`eval/results/`, 2026-09-20):

| Arm | Pass | Total cost | Cost per success |
|---|---|---|---|
| `fixed_frontier` (Sonnet 5) | 5/5 | $0.5722 | $0.1144 |
| `router_role` (pinned routes) | 5/5 | $1.5732 | $0.3146 |
| `router_frontier` (knee) | 5/5 | $0.1993 | $0.0399 |

The frontier arm sent all three code tasks to `z-ai/glm-5.3-flash`, planning to
`anthropic/claude-sonnet-5` and writing to `openai/gpt-5.4-mini`. Classification
overhead is excluded and five tasks do not establish a general saving rate.

### Benchmark, 26 September 2026

Pass counts by model and task kind (planning / hard code / writing):

| Model | Planning | Hard code | Writing |
|---|---|---|---|
| `anthropic/claude-opus-5.5` | 4/4 | 10/10 | 2/2 |
| `openai/gpt-6-sol` | 4/4 | 10/10 | 6/6 |
| `google/gemini-3.8-flash` | 4/4 | 6/10 | 2/2 |
| `openai/gpt-5.6-luna` | — | — | 4/4 |

Total spend: $5.52. Seven rows across these runs were adjudicated: a human
read the artifact and found it correct where a verifier rule rejected it on
phrasing. See `eval/results/ADJUDICATIONS.md` for each row and the reason.

### Replay, 26 September 2026

`eval/replay.ts` replayed the 151-row ledger through the selector as built
(147 rows classified, 4 skipped). Picks by kind:

| Kind | Pick | Count |
|---|---|---|
| planning | `anthropic/claude-opus-5.5` | 1 |
| planning | (abstain, confident clarify) | 5 |
| code | `inclusionai/ling-3.0-flash` | 24 |
| code | (abstain, confident clarify) | 16 |
| writing | `openai/gpt-5.6-luna` | 10 |
| writing | (abstain, confident clarify) | 1 |
| other | `z-ai/glm-5.3-flash` | 24 |
| other | (abstain, confident clarify) | 66 |

Planning picks a top-tier model only, and writing picks an OpenAI model only,
as the role policy requires. Every abstain is a confident `clarify` brief;
no other row abstains. Code does not separate by complexity on this ledger:
the pick is `inclusionai/ling-3.0-flash` from complexity 0.16 to 2.54. This
matches the benchmark, not a bug in the pick: calibrated code quality spans
only about 0.90 to 0.96 across measured models, and the hard-suite and
overall evidence cells track closely, so the value function has little room
to move the pick on complexity alone.

Live trial: pending (run `/router auto --dry-run 5` after merge).

## Setup

```bash
npm install
```

Set `OPENROUTER_API_KEY`, or reuse the key stored in `~/.pi/agent/auth.json`.
Copy `config/models.openrouter.json` into `~/.pi/agent/models.json`.

Auto-load globally:
```bash
mkdir -p ~/.pi/agent/extensions
ln -sf ~/Documents/GitHub/pi-jev-router ~/.pi/agent/extensions/pi-jev-router
```
Then start `pi` normally (no `-e` required).

## Tests

```bash
npm test
```

## Worktree isolation

Workers dispatched via `dispatch_task` execute in isolated Git worktrees:
- Worker edits code on a separate task branch (`task/<id>`).
- If `verifierCommand` passes (exit 0), changes merge cleanly into the repository.
- If verification fails or aborts, the worktree is cleaned up without leaving dirty changes.

## Ledger

Each dispatch is recorded with its outcome: verified pass, verifier failed, worker error, handshake missing, or no verifier. Outcomes are recorded but not yet used as evidence. Environment failures cannot yet be separated from work failures, so outcomes cannot safely move a pick.

## Files

- `src/classifier.ts` — Jev call. One request, five questions.
- `src/catalog.ts` — fetch, cache and normalise the OpenRouter catalog.
- `src/evidence.ts` — per-model, per-work-kind statistics from `eval/results`.
- `src/frontier.ts` — Pareto dominance, the knee point and the weighted fallback.
- `src/selector.ts` — scores models and selects one. Pure functions. No model calls.
- `src/board.ts` — SQLite task state.
- `src/dispatch.ts` — worker spawn and handshake.
- `extensions/router.ts` — pi hooks and commands.
- `eval/` — benchmark tasks, verifiers, runner.
