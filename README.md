# pi-jev-router: a minimal Pareto-optimal OpenRouter model router for pi, based on Jev

pi-jev-router is a pi extension. It classifies each task with Jev (TypeSafe
System One, called through OpenRouter) and routes the task to an OpenRouter
model. The pick balances quality, cost and latency, and follows a role
policy for planning, code and writing.

The default mode is shadow: the router records what it would pick and does
not switch. Use `/router auto` or `/router auto --dry-run N` to let it switch.

## How a pick is made

1. **Continuation check.** A bare continuation ("continue", "go on", "keep
   going", "yes", "ok", "do it", …) keeps the current model and skips Jev.
   A continuation after an abstain or a manual pin classifies normally.
2. **Classification.** One Jev call per task, with a bounded context block
   from the session and the repository. Five questions: category,
   complexity, risk, brief and decompose. The categories include `planning`
   and `writing`, so prose and planning tasks do not route as code.
3. **Work kind.** The category and a few text rules map the task to
   planning, code, writing or other. A short continuation that Jev calls
   `unclear` inherits the previous work kind.
4. **Abstain.** If Jev is confident (0.7 or more) that the brief needs
   clarification, the router does not switch. The current model asks.
5. **Eligibility.** Hard gates remove infeasible models: no tool support,
   context too small, a zero or sentinel price, an expired preview, a
   measured pass rate under the quality floor (0.65), and, for risk 2 or
   higher, fewer than three measured runs. Then the role policy applies
   (see below). If nothing is left, the gates relax in a fixed order and
   the ledger records which one relaxed.
6. **Frontier and pick.** The router builds the Pareto frontier over
   quality, cost and latency. A weighted value function picks from it:
   quality minus cost and latency, weighted by work kind and by complexity
   (a hard task weighs cost less; a hard code task, complexity 2 or more,
   uses the planning weights). The knee of the frontier is computed and
   recorded as `kneeId` for diagnostics only.

**Quality** is the measured pass rate from `eval/results`, smoothed toward
a prior. The prior is the Artificial Analysis index (EQ-Bench Creative
Writing Elo for writing), mapped onto the range of measured pass rates, so
a measured and an unmeasured model compare on one scale. A model that lists
a sub-index as 0 falls back to its intelligence rank. Tasks with complexity
2 or higher read the hard-suite evidence once a model has two hard runs.

**Cost** is a per-task estimate from catalogue prices, replaced by the
measured mean as runs accumulate. **Latency** uses measured means when they
exist.

## Role policy

| Work kind | Eligible models | Thinking |
|---|---|---|
| Planning | Artificial Analysis intelligence index of 48.5 or more; or 44.5 or more with 3 or more measured planning runs; or, for a model with no index, 4 or more measured planning runs, all passed | high |
| Code | every feasible model | medium |
| Writing | OpenAI models with a writing Elo of 1760 or more, or 3 or more measured writing runs | low |
| Other | every feasible model | medium |

Writing turns also get the Humanizer and Simplified Technical English (STE)
directive. The thresholds sit in measured gaps; `src/selector.ts` records
each gap next to its constant.

On the current catalog and evidence, planning routes to
`anthropic/claude-opus-5.5`, easy code to `inclusionai/ling-3.0-flash`,
hard code to `anthropic/claude-opus-5.5` and writing to
`openai/gpt-5.6-luna`. `openai/gpt-6-sol` is eligible for planning on its
measured runs.

## Commands

```text
/router                    show status, the loaded version and the ledger path
/router shadow             recommend only (default)
/router auto               switch models per task
/router auto --dry-run N   switch for N tasks, then return to shadow with a summary
/router off                stop routing
/router frontier           show the frontier for the last decision
/router pin <id>           force a model; /router pin off releases it
/router budget <usd>       session spend cap for automatic switching
/router subscription <provider,...> | off
/router test               classify a sample task and show the pick
```

`/chief start | board | verify | events | accept | cancel` manages
dispatched tasks. The `dispatch_task` tool sends a subtask to an isolated
worker. The worker gets the same frontier pick for its role, runs in its own
Git worktree, and its changes merge only when `verifierCommand` exits 0.

The budget counts the main session's model spend, classifier calls and
dispatched workers. When the budget is reached, the router switches to the
cheapest model on the task's frontier and warns. A pin does not override
the budget.

## Setup

```bash
npm install
```

Set `OPENROUTER_API_KEY`, or reuse the key stored in `~/.pi/agent/auth.json`.
Copy `config/models.openrouter.json` into `~/.pi/agent/models.json`.

Load the extension in every pi session:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf ~/Documents/GitHub/pi-jev-router ~/.pi/agent/extensions/pi-jev-router
```

Then start `pi` normally. pi loads the extension once per process. After an
update, restart pi. `/router status` warns when the loaded version differs
from the checkout on disk.

## Ledger and diagnostics

Every decision is appended to `~/.pi/agent/jev-router/decisions.jsonl`. A
row records the pick (`recommendation.modelId`), the model that actually ran
(`activeModel`), the reason, the classifier answers, the first 400
characters of the context block, the context size and the loaded
`routerVersion`. A failed ledger write prints one line to stderr and never
breaks a task.

Each dispatch is recorded with its outcome: verified pass, verifier failed,
worker error, handshake missing or no verifier. Outcomes are recorded but
not yet used as evidence, because environment failures cannot yet be told
apart from work failures.

A long session reloads the catalog after 12 hours and the evidence when a
new result file appears.

Two offline tools check a change before it goes live:

```bash
node --experimental-strip-types eval/replay.ts [--rows]   # replay the ledger through the current selector
node --experimental-strip-types eval/classifier-eval.ts  # work-kind accuracy on eval/classifier-set.jsonl (live, about $0.002)
```

`eval/replay.ts` makes no model calls. Run it before and after any
selection change and compare the picks. Replay records are in
`docs/replay-baseline-2026-09-26.txt` and `docs/replay-after-2026-09-26.txt`.

## Benchmark

```bash
npm run bench                    # fixed baseline vs frontier router
npm run bench -- --hard          # hard and ceiling code tasks, strict STE writing
npm run bench -- --ceiling       # code tasks with hidden tests only
npm run bench -- --planning      # the two structural planning tasks
npm run bench -- --suite         # every task
npm run bench -- --models=a,b    # measure named models directly
npm run bench -- --task=<id>     # one task
```

The benchmark calls real models and costs money. Run it on purpose, not per
commit.

Each task runs in an isolated workspace with an independent verifier.
Every verifier is checked both ways: it fails the starting state and a
plausible wrong answer, and it passes a correct answer. Ceiling tasks score
against tests the model never sees. Planning verifiers check structure: the
expand-and-contract order for a column migration, and step order and owners
for an incident runbook.

Evidence is scored when it is read (`src/evidence.ts`): more than 12 turns
or a timeout counts as a failure.

A verifier is never loosened to pass one artifact. When a correct artifact
fails on phrasing, a human reads it and records an adjudication in
`eval/results/ADJUDICATIONS.md`. That file also lists the known holes that
the strict verifiers share with earlier versions.

### Results, 26 September 2026

Scored the way the router reads them. Total spend $5.52.

| Model | Planning | Hard code | Writing |
|---|---|---|---|
| `anthropic/claude-opus-5.5` | 4/4 | 10/10 | 2/2 |
| `openai/gpt-6-sol` | 4/4 | 10/10 | 6/6 |
| `google/gemini-3.8-flash` | 2/4 | 2/10 | 2/2 |
| `openai/gpt-5.6-luna` | — | — | 4/4 |

Seven of these rows are adjudicated. Runner pass counts differ where a run
went over the turn budget or timed out, mostly for `google/gemini-3.8-flash`.
Earlier runs, from 20 to 25 September, are in `eval/results/`.

## Policy decisions, 27 September 2026

- **Planning** also admits a model with an intelligence index of 44.5 or
  more and 3 or more measured planning runs. The line sits in the gap among
  measured planners from `openai/gpt-6-sol` (47.5, 4 of 4) to
  `z-ai/glm-5.3-flash` (41.8). Without the second line, planning had one
  candidate.
- **Hard code** (complexity 2 or more) weighs cost like planning. With the
  code weights, `inclusionai/ling-3.0-flash` won at every complexity. The
  replay now sends 3 of 24 code tasks to `anthropic/claude-opus-5.5`.
- **Over budget**, the router drops to the cheapest capable model instead of
  staying on the model that ran last.
- **A model with no intelligence index** (for example `fireworks/ember-1`)
  can take planning on 4 or more measured planning runs, all passed. No
  index line can apply to it otherwise.

## Subscription routing

Off by default. The frontier picks the model; this only changes how that
model is reached.

```text
/router subscription openai-codex     route through a logged-in plan
/router subscription off              back to metered routes
/router subscription                  show status and cooldowns
```

A plan route is best effort. A ChatGPT account does not support every Codex
model, and a plan can hit its usage limit mid-session. On 22 and 25
September, three Codex models were unsupported on this plan and the other
three were at their usage limit, so the route has not yet served a request.
A refusal puts the route on a cooldown and falls back to the metered route:
30 days for an unsupported model, one hour for a usage limit, ten minutes for
anything else.

Anthropic is a different case. pi lists the same price on both routes, and
pi's docs state that third-party harness usage draws from extra usage billed
per token rather than plan limits. Enabling it changes the invoice, not the
cost.

## Tests

```bash
npm test
```

`npm test` makes no model calls. Tests write router state to a temp
directory, never to `~/.pi/agent/jev-router`.

## Files

- `src/classifier.ts` — the Jev call. One request, five questions.
- `src/context.ts` — the bounded context block for the classifier.
- `src/continuity.ts` — continuations, inherited work kinds, tokenizer margins.
- `src/catalog.ts` — fetch, cache and normalise the OpenRouter catalog.
- `src/evidence.ts` — per-model, per-work-kind statistics from `eval/results`, with a hard-suite cell.
- `src/writing-prior.ts` — EQ-Bench Creative Writing Elo per model.
- `src/frontier.ts` — Pareto dominance, the weighted value function that picks the model, and the knee point, which is reported for diagnostics.
- `src/selector.ts` — gates, role policy, calibrated priors and the pick. Pure functions. No model calls.
- `src/ledger.ts` — the decision ledger.
- `src/version.ts` — the loaded package version.
- `src/session-state.ts` — session spend and reload checks.
- `src/subscription.ts` — plan routes and cooldowns.
- `src/board.ts` — SQLite task state.
- `src/dispatch.ts` — worker spawn, handshake and outcome.
- `src/worktree.ts` — worker worktrees.
- `extensions/router.ts` — pi hooks and `/router`.
- `extensions/chief.ts` — `/chief`.
- `eval/` — benchmark tasks, verifiers, runner, replay and classifier eval.
