# pi-jev-router

Jev-classified, cost-aware model routing for the [pi coding agent](https://pi.dev).
Status: **M1 — shadow mode**. Classifies tasks with [Jev](https://typesafe.ai) (via OpenRouter's
System One API) and recommends a model from a deterministic local policy. It **never changes the
active model** in this milestone.

## Design principle

> Jev identifies what the task needs. Evaluations establish which models can do it.
> Code selects the cheapest eligible option. Verification confirms the work succeeded.

Jev output is evidence, not truth: probabilities and confidence are preserved separately and never
interpreted as "the recommended model will succeed with X% probability."

## Install / try

```bash
cd ~/Documents/GitHub/pi-jev-router && npm install
pi -e ./extensions/router.ts          # or install into ~/.pi/agent/packages
```

Requires an OpenRouter account. The classifier uses `OPENROUTER_API_KEY`, falling back to the
credential Pi stores in `~/.pi/agent/auth.json`.

## Commands

| Command | Effect |
|---|---|
| `/router` | Status: mode, pin, budget, last decision, ledger path, allowlist |
| `/router shadow` | Recommend only (default) |
| `/router auto` | Switch models at task boundaries via `pi.setModel()` |
| `/router off` | Disable |
| `/router pin <id>` | Force a specific OpenRouter model id |
| `/router budget <usd>` | Session spend cap for auto mode |
| `/router test` | Classify a sample task end-to-end |

Each top-level task triggers one batched Jev request (category / complexity / risk / brief /
decompose). The decision is appended to `~/.pi/agent/jev-router/decisions.jsonl`.

## Role-based routing

The router automatically classifies every top-level task and applies your preferred model classes:

| Role | Target | Thinking | Notes |
|---|---|---|---|
| **Planning** | `anthropic/claude-fable-5.1` | high | Frontier intelligence with superior planning capabilities |
| **Code / review** | `openrouter/pareto-code` | medium | OpenRouter expert Pareto coding router |
| **Writing / prose** | `openai/gpt-5.4-mini` | low | Fast OpenAI model + **automatic /humanizer & Simplified Technical English (STE) style directive** |
| **Other** | tier-based (`DEFAULT_POLICY`) | by tier | Complexity/risk-driven tier assignment |

### Automatic Chief (no separate command needed)

You never need to run `/chief start` manually:
1. Every task is classified and the **main session switches automatically** to the right model.
2. The `dispatch_task` tool is registered inside every session: a planning model can delegate implementation subtasks to isolated workers itself.
3. Writing tasks automatically receive the humanizer and STE rules prepended to their system prompt.

The `/chief` command remains available for inspecting the durable SQLite task board (`/chief board`), checking events (`/chief events <id>`), or running independent verification checks (`/chief verify <id> <cmd>`).

## Tests

```bash
node --experimental-strip-types tests/selector.test.ts   # deterministic policy fixtures
```

## Roadmap

- **M2** — auto mode: actually route top-level tasks (`pi.setModel` + thinking level), stickiness,
  escalation, budget reservation, context-downgrade guard.
- **M3** — Chief of Staff: SQLite task board, durable briefs, isolated JSON-mode workers in
  worktrees, independent verification.
- **M4** — empirical frontier: measured success/cost per candidate, quality floors, canary rollout.

See `~/Downloads/jev-pi-openrouter-routing-plan.md` for the full plan.