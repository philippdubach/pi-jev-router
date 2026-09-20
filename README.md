# pi-jev-router: a minimal Pareto-optimal OpenRouter model router for pi, based on Jev

Jev-classified model routing for pi. 

## Model rules

| Role | Model | Thinking |
|---|---|---|
| Planning | `anthropic/claude-sonnet-5` | high |
| Code | `openrouter/pareto-code` | medium |
| Writing | `openai/gpt-5.4-mini` | low |

Writing tasks get STE and Humanizer rules. Code tasks run unit tests.
Planning tasks get a structure check.

## Commands

```text
/router          show status
/router shadow   recommend only (default)
/router auto     switch models per task
/router off      stop routing
/router profile pareto_code | empirical_cost
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
- `src/selector.ts` — policy. No model calls.
- `src/board.ts` — SQLite task state.
- `src/dispatch.ts` — worker spawn and handshake.
- `extensions/router.ts` — pi hooks and commands.
- `eval/` — benchmark tasks, verifiers, runner.
