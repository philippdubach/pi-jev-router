# AGENTS.md

Rules for agents working in this repository.

## Scope

This is a pi extension package. It routes tasks to models. Do not add
features outside this scope. Do not add a server, a dashboard, or an MCP layer.

## Architecture

- `src/classifier.ts` calls Jev through OpenRouter. One batched request per task. Five questions: category, complexity, risk, brief, decompose.
- `src/selector.ts` maps classification results to models. Pure functions. No network calls. No model calls.
- `src/board.ts` owns task state in SQLite. Transitions are compare-and-set. Only the acceptance path marks a task done.
- `src/dispatch.ts` spawns isolated `pi --mode json -p` workers. Each worker gets a brief file, a nonce, and a summary handshake.
- `extensions/router.ts` and `extensions/chief.ts` are the only pi entry points.

## Hard rules

1. Jev output is evidence, not truth. Never treat a Jev answer as a guarantee of task success.
2. Never route mid-tool-call. Route only at task, subtask, and retry boundaries.
3. Never trust a worker's self-report. Run the verifier. Read the exit code.
4. Never replay a completed side-effecting tool call after a timeout.
5. Keep the model allowlist in `src/selector.ts` explicit. Never route to an unlisted model.
6. Budget gates apply to automatic routing. A pin cannot bypass a budget or a security check.
7. Workers get `--no-extensions` and `--no-context-files`. A worker must not spawn workers.
8. Do not commit, push, or deploy from a worker.

## Verification

- Code tasks: run the unit tests. Exit code decides. A summary is intent.
- Planning tasks: check for the required components in the artifact.
- Writing tasks: check sentence length, banned AI words, and required sections.
- A check that matched nothing must say so. Distinguish passed, failed, zero-match, and error.

## Style

- Write STE. Short sentences. One idea per sentence. Active voice.
- No AI filler: no "delve", "testament", "furthermore", "moreover", "in conclusion", no "not X but Y".
- Keep answers short. Show file paths. Do not restate the plan.

## Tests

```bash
node --experimental-strip-types tests/selector.test.ts
node --experimental-strip-types tests/role-routing.test.ts
node --experimental-strip-types eval/index.ts
```

All must pass before you commit. One task per commit. No AI attribution in commit messages.

## Cost discipline

- Each Jev call costs about $0.00004. Do not classify more than once per task.
- Never send the full conversation to Jev. Send a bounded envelope.
- Record every routing decision in the ledger. Include resolved model, cost, and fallback reason.
