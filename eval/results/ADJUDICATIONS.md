# Adjudications

## What an adjudication is

An adjudication is a human-reviewed override of one benchmark row.

- A person reads the artifact and finds it correct.
- The verifier rejects the artifact because a verifier rule is too strict.
- The row keeps `passed: true` and `correct: true`.
- The row keeps the verifier's real output in `verifierOutput`.
- The row has an `adjudicated` note. The note tells what the artifact does right and which rule rejects it.

We do not make the verifier looser to accept these artifacts. A false FAIL is better than a false PASS. A looser rule lets wrong plans pass, and the router then trusts a model too much.

The verifiers are the pre-Task-9 logic with two parsing fixes (ruling R14):

1. Qualified-name dots. A "." with a non-space character after it (`users.full_name`) is not a sentence end. It becomes a space.
2. Fenced code blocks. A fenced block and the blank line before it stay in the current step, so a fenced `DROP COLUMN` stays in its step's text.

Each fix has a negative control (a wrong plan that must fail) and a positive control (a correct plan that must pass) in `tests/planning-verifiers.test.ts`.

A future run of the same model can write the same phrasing. The verifier will then give FAIL again. A person must read that artifact and adjudicate it, or leave the FAIL.

Only the 26 and 27 September runs were re-read under this standard. Older rows, for
example the two `z-ai/glm-5.3-flash` `write_strict_ste` FAILs from
2026-09-22 and 2026-09-25, were not re-read and keep the verifier's verdict.

## Adjudicated rows

`<tmp>` is the value of `node -e 'console.log(require("os").tmpdir())'`. The artifacts are local to the benchmark machine. The fixture is the committed copy.

| Result file | Model | Task | Artifact | Fixture | Reason the verifier rejects it |
|---|---|---|---|---|---|
| `benchmark-2026-09-26T16-51-32-175Z.json` | `anthropic/claude-opus-5.5` | `plan_expand_contract` | `<tmp>/pi-jev-benchmarks/bench-muimbccr/model_anthropic_claude-opus-5.5/plan_expand_contract/migration-plan.md` | `tests/fixtures/opus-migration-plan-fenced-drop.md` | The switch-read rule matches the Step 0 inventory ("reads in Release 3"), which comes before the backfill. The drop rule matches "remove the column from the ORM model" in the Release 4 stop-write step. The real `DROP COLUMN` is in Release 5. |
| `benchmark-2026-09-26T16-51-32-175Z.json` | `openai/gpt-6-sol` | `plan_expand_contract` | `<tmp>/pi-jev-benchmarks/bench-muimbccr/model_openai_gpt-6-sol/plan_expand_contract/migration-plan.md` | `tests/fixtures/gpt6sol-migration-plan-qualified-names.md` | The dual-write rule does not match "write full_name, first_name, and last_name together". It takes a later step as the dual-write, so the backfill seems to come first. |
| `benchmark-2026-09-26T16-51-32-175Z.json` | `google/gemini-3.8-flash` | `plan_expand_contract` | `<tmp>/pi-jev-benchmarks/bench-muimbccr/model_google_gemini-3.8-flash/plan_expand_contract/migration-plan.md` | `tests/fixtures/gemini-migration-plan-business-rules.md` | The preamble rule does not skip the numbered list under "Name Splitting Logic & Business Rules". A dual-write rule in that list comes before the step that adds the column. |
| `benchmark-2026-09-26T16-59-18-462Z.json` | `google/gemini-3.8-flash` | `plan_expand_contract` | `<tmp>/pi-jev-benchmarks/bench-muimn84p/model_google_gemini-3.8-flash/plan_expand_contract/migration-plan.md` | `tests/fixtures/gemini-migration-plan-object-first-stopwrite.md` | The switch-read and stop-write rules match only verb-first forms. The plan states them object-first ("Read Path: Read directly from first_name", "with Old Writes Removed"). The preamble rule also does not skip the "Name Parsing & Data Integrity Rules" list. |
| `benchmark-2026-09-26T17-12-29-320Z.json` | `openai/gpt-6-sol` | `write_strict_ste` | `<tmp>/pi-jev-benchmarks/bench-muimx671/model_openai_gpt-6-sol/write_strict_ste/runbook.md` | `tests/fixtures/gpt6sol-runbook-list-object.md` | The compound-instruction rule flags a sentence of more than 8 words with "and" before another word. It flags one verb with a list object: "Identify the consumer service, queue, deployment environment, and owning team." |
| `benchmark-2026-09-26T17-23-43-100Z.json` | `openai/gpt-6-sol` | `write_strict_ste` | `<tmp>/pi-jev-benchmarks/bench-muinrzea/model_openai_gpt-6-sol/write_strict_ste/runbook.md` | `tests/fixtures/gpt6sol-runbook-list-object-2.md` | Same rule. Example: "Identify the consumer deployment, queue, environment, and consumer group." |
| `benchmark-2026-09-26T17-24-09-378Z.json` | `openai/gpt-6-sol` | `write_strict_ste` | `<tmp>/pi-jev-benchmarks/bench-muinshha/model_openai_gpt-6-sol/write_strict_ste/runbook.md` | `tests/fixtures/gpt6sol-runbook-list-object-3.md` | Same rule. Example: "Identify the consumer deployment, queue, environment, and owning team." |
| `benchmark-2026-09-27T19-31-22-756Z.json` | `fireworks/ember-1` | `plan_expand_contract` | `<tmp>/pi-jev-benchmarks/bench-muk7qyay/model_fireworks_ember-1/plan_expand_contract/migration-plan.md` | `tests/fixtures/ember-migration-plan-add-without-column-word.md` | The add rule needs the word "column"; the plan says "add `first_name TEXT NULL` and `last_name TEXT NULL`". The stop-write rule does not match "writes only `first_name`/`last_name` and no longer sets `full_name`". The order is correct: add, dual-write and backfill in N+1, reads in N+2, write stop in N+3, drop in N+4. |

One more row was rescored, not adjudicated: `benchmark-2026-09-26T16-59-18-462Z.json`, `openai/gpt-6-sol`, `plan_expand_contract`. The verifier passes it with the qualified-name dot fix. Its fixture, `tests/fixtures/gpt6sol-migration-plan-qualified-names-2.md`, is the positive control for that fix.

## Known holes

A known hole is a wrong artifact that the verifier passes. The pre-Task-9 verifier also passes each one, so none is new. The tests print `SKIP` for each one and do not fail. To close a hole, make the verifier stricter. Then move the case to the asserted probes.

| Verifier | Test file | Case | Why the verifier passes it |
|---|---|---|---|
| `verifyMigrationPlan` | `tests/planning-verifiers.test.ts` | "Drop full_name." in the stop-write release, then "Delete the leftover trigger on the old column." in a later release | The drop object must contain "column" or "field". "Drop full_name" has neither, so the verifier takes the later trigger step as the drop. |
| `verifyStrictSTE` | `tests/hard-verifiers.test.ts` | "Stop the consumer, drain queues, and restart pods." | The compound rule applies only to sentences of more than 8 words. This sentence has 8. |
| `verifyStrictSTE` | `tests/hard-verifiers.test.ts` | "Stop the consumer, drain all queues, and redeploy." | Same: 8 words. |
