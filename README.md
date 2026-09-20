# pi-jev-router: a minimal Pareto-optimal OpenRouter model router for pi, based on Jev

Jev-classified model routing for pi. 

## Model rules

The `frontier` profile ranks the whole OpenRouter catalog for each task. It
filters the catalog to models that fit the task, computes a Pareto frontier over
quality, cost and latency, then picks the knee point. The knee is the frontier
member farthest from the chord that joins the cheapest and dearest models. It
needs no weights, so the pick follows the catalog and the recorded evidence on
every task. A frontier too small or too flat for a knee falls back to a weighted
value function.

Quality blends recorded runs from `eval/results` with the Artificial Analysis
index. Writing quality uses the EQ-Bench Creative Writing v3 Elo in
`src/writing-prior.ts` instead, because a general intelligence index says
nothing about prose. Cost is a per-task estimate from catalogue prices,
replaced by recorded mean cost as runs accumulate. Latency uses recorded means
when they exist.

`pareto_code` and `empirical_cost` stay pinned, so the benchmark can measure the
frontier profile against fixed routes.

| Profile | Route |
|---|---|
| `frontier` (default) | knee point of the task's feasible frontier |
| `pareto_code` | Planning `anthropic/claude-sonnet-5`, Code `openrouter/pareto-code`, Writing `openai/gpt-5.4-mini` |
| `empirical_cost` | `anthropic/claude-sonnet-5` for planning and code, `openai/gpt-5.4-mini` for writing |

Writing tasks get STE and Humanizer rules. Code tasks run unit tests.
Planning tasks get a structure check.

## Commands

```text
/router           show status
/router shadow    recommend only (default)
/router auto      switch models per task
/router off       stop routing
/router profile frontier | pareto_code | empirical_cost
/router frontier  show the frontier for the last decision
/router budget <usd>
```

## Benchmarks

```bash
node --experimental-strip-types eval/index.ts
```

Results: writing 89% cheaper. Code 88% cheaper with `empirical_cost`.
Planning 100% pass on `claude-sonnet-5`.

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

## Worktree isolation

Workers dispatched via `dispatch_task` execute in isolated Git worktrees:
- Worker edits code on a separate task branch (`task/<id>`).
- If `verifierCommand` passes (exit 0), changes merge cleanly into the repository.
- If verification fails or aborts, the worktree is cleaned up without leaving dirty changes.

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
