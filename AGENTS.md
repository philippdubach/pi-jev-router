# AGENTS.md

Rules for agents working in this repository.

## Scope

This is a pi extension package. It routes tasks to models. Do not add
features outside this scope. Do not add a server, a dashboard, or an MCP layer.

## Architecture

- `src/classifier.ts` calls Jev through OpenRouter. One batched request per task. Five questions: category, complexity, risk, brief, decompose. Categories include `planning` and `writing`.
- `src/context.ts` builds the bounded context block that reaches the classifier.
- `src/continuity.ts` decides what depends on the previous turn: bare continuations, inherited work kinds, tokenizer margins. Pure functions.
- `src/catalog.ts` fetches, caches and normalises the OpenRouter catalog. It owns every network call for model data.
- `src/evidence.ts` aggregates `eval/results` into per-model, per-work-kind statistics, with a hard-suite cell. It scores each run when it reads it (turn budget, timeouts).
- `src/frontier.ts` computes Pareto dominance, the weighted value function that picks the model, and the knee point, which is reported for diagnostics. Pure functions.
- `src/selector.ts` applies the gates and the role policy, calibrates quality priors and selects one model. Pure functions. No network calls. No file reads. The caller supplies the catalog and the evidence.
- `src/ledger.ts` appends decisions to the ledger. `src/version.ts` gives the loaded version. `src/session-state.ts` holds pure helpers for session spend and reloads.
- `src/board.ts` owns task state in SQLite. Transitions are compare-and-set. Only the acceptance path marks a task done.
- `src/dispatch.ts` spawns isolated `pi --mode json -p` workers. Each worker gets a brief file, a nonce, and a summary handshake. Each dispatch is recorded with its outcome.
- `extensions/router.ts` and `extensions/chief.ts` are the only pi entry points.

## Hard rules

1. Jev output is evidence, not truth. Never treat a Jev answer as a guarantee of task success.
2. Never route mid-tool-call. Route only at task, subtask, and retry boundaries.
3. Never trust a worker's self-report. Run the verifier. Read the exit code.
4. Never replay a completed side-effecting tool call after a timeout.
5. Route only to models the catalog lists as feasible for the task. A model with fewer than three recorded runs for the work kind cannot take a task with risk 2 or higher. The bootstrap list in `src/catalog.ts` applies only when the catalog is unavailable.
6. Budget gates apply to automatic routing. A pin cannot bypass a budget or a security check.
7. Workers get `--no-extensions` and `--no-context-files`. A worker must not spawn workers.
8. Do not commit, push, or deploy from a worker.
9. The role policy is the user's decision. Do not change `PLANNING_MIN_INTELLIGENCE`, `PLANNING_MEASURED_MIN_INTELLIGENCE`, `PLANNING_UNINDEXED_MIN_RUNS`, `WRITING_VENDORS`, `WRITING_MIN_ELO`, `PROFILE_WEIGHTS`, `HARD_CODE_WEIGHTS` or the over-budget fallback without the user's approval.
10. A ledger write must never break a task. Keep `record()` free of throws.

## Selection changes

- Run `node --experimental-strip-types eval/replay.ts` before and after a change to `src/selector.ts`, `src/frontier.ts` or `src/evidence.ts`. Report the change in picks per work kind.
- Place a threshold in a gap of a measured distribution. Record the gap and the values on both sides in the constant's comment. Do not pick a threshold by taste.
- Apply policy when evidence is read, not when it is recorded. Do not edit old result files to fit a new rule.

## Verification

- Code tasks: run the unit tests. Exit code decides. A summary is intent.
- Planning tasks: check the structure of the artifact, such as step order and owners. A keyword count is not a check.
- Writing tasks: check sentence length, banned AI words, and required sections.
- A check that matched nothing must say so. Distinguish passed, failed, zero-match, and error.
- Check every verifier both ways: it must fail a wrong or empty artifact and pass a correct one.
- Never loosen a verifier to make one artifact pass. A false FAIL is better than a false PASS. When a correct artifact fails on phrasing, record an adjudication in `eval/results/ADJUDICATIONS.md` instead. A committed wrong-plan probe must keep failing.

## Style

- Write STE. Short sentences. One idea per sentence. Active voice.
- No AI filler: no "delve", "testament", "furthermore", "moreover", "in conclusion", no "not X but Y".
- Keep answers short. Show file paths. Do not restate the plan.

## Tests

```bash
npm test
```

`npm test` runs every file listed in the `"test"` script in `package.json`. Add each new test file there. It makes no model calls. `npm run bench` and `eval/classifier-eval.ts` call real models and cost money, so run them deliberately, not per commit.

A test that touches `src/board.ts`, `src/ledger.ts` or `src/dispatch.ts` must import `./_isolate.ts` first. That keeps it away from the real router directory.

Strip-only TypeScript: `node --experimental-strip-types`. No parameter properties, enums or namespaces.

All tests must pass before you commit. One task per commit. No AI attribution in commit messages.

## Cost discipline

- Each Jev call costs about $0.00004. Do not classify more than once per task. A bare continuation is not a new task.
- Never send the full conversation to Jev. Send a bounded envelope.
- Record every routing decision in the ledger. Include resolved model, active model, cost, and fallback reason.
