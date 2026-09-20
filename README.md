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
| `/router` | Status: mode, last decision, ledger path, allowlist |
| `/router shadow` | Enable shadow classification (default) |
| `/router off` | Disable |
| `/router test` | Classify a sample task end-to-end |

Each top-level task triggers one batched Jev request (category / complexity / risk / brief /
decompose). The decision is appended to `~/.pi/agent/jev-router/decisions.jsonl`.

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