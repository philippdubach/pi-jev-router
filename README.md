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

### One-time Pareto registration

Pi 0.85.1's built-in OpenRouter catalogue does not include `openrouter/pareto-code`. Add the model
entry from `config/models.openrouter.json` into `~/.pi/agent/models.json`, then **restart Pi**. This
machine is already configured. Verify it with:

```bash
pi --provider openrouter --model openrouter/pareto-code --thinking high -p 'Reply exactly: PARETO PI OK'
```

The model's router-level catalogue price is unknown (`-1`), so its Pi cost estimate is zero. Treat
OpenRouter's returned generation cost—not Pi's estimate—as authoritative.

## Commands

| Command | Effect |
|---|---|
| `/router` | Status: mode, pin, budget, last decision, ledger path, allowlist |
| `/router shadow` | Recommend only (default) |
| `/router auto` | Switch models at task boundaries via `pi.setModel()` |
| `/router off` | Disable |
| `/router profile <name>` | Select profile: `pareto_code` (default) or `empirical_cost` |
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
| **Code / review** | `openrouter/pareto-code` | high | OpenRouter expert Pareto coding router |
| **Writing / prose** | `openai/gpt-5.4-mini` | low | Fast OpenAI model + **automatic /humanizer & Simplified Technical English (STE) style directive** |
| **Other** | tier-based (`DEFAULT_POLICY`) | by tier | Complexity/risk-driven tier assignment |

### Automatic Chief (no separate command needed)

You never need to run `/chief start` manually:
1. Every task is classified and the **main session switches automatically** to the right model.
2. The `dispatch_task` tool is registered inside every session: a planning model can delegate implementation subtasks to isolated workers itself.
3. Writing tasks automatically receive the humanizer and STE rules prepended to their system prompt.

The `/chief` command remains available for inspecting the durable SQLite task board (`/chief board`), checking events (`/chief events <id>`), or running independent verification checks (`/chief verify <id> <cmd>`).

## Benchmarks

A structured execution benchmark suite is included in `eval/`. It dispatches separate, isolated `pi` sessions across diverse tasks with independent verifiers:

- **Code tasks**: LRU Cache with TTL, SemVer comparator, async retry queue (verified by unit test exit codes)
- **Planning tasks**: Distributed rate limiter architecture (verified by static AST/technical criteria)
- **Writing tasks**: Technical postmortems (verified by automated STE sentence-length and AI trope linter)

Run the benchmark suite:

```bash
# Run all benchmark tasks across baseline and role router:
node --experimental-strip-types eval/index.ts

# Run a single task:
node --experimental-strip-types eval/index.ts --task=code_semver_sort
node --experimental-strip-types eval/index.ts --task=write_incident_postmortem
node --experimental-strip-types eval/index.ts --task=plan_distributed_ratelimiter
```

Detailed JSON and Markdown reports are saved to `eval/results/`.

### Empirical benchmark findings

1. **Technical Writing / Prose**: `openai/gpt-5.4-mini` (low thinking) with STE & Humanizer directives achieved **89% cost savings** ($0.012 vs $0.113) and **2.7x faster** response time while passing 100% of STE and AI-trope linter checks.
2. **Architecture & Planning**: `anthropic/claude-sonnet-5` (high thinking) consistently passed 100% of complex multi-region architecture verifications in ~100s without timeout ($0.17/task). `claude-fable-5.1` produced massive reasoning traces that frequently hit timeouts (>180s).
3. **Coding / Bug fixing**: `openrouter/pareto-code` achieved 100% test pass rate. Unconstrained, it resolves to `claude-fable-5.1` ($0.70/task). Running under `/router profile empirical_cost` routes code to `claude-sonnet-5`, delivering the exact same 100% test pass rate at **88% lower cost** ($0.08 - $0.10/task).

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