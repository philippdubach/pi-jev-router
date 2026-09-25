/**
 * Planning tasks whose verifiers check structure, not keywords.
 *
 * The original planning task looked for five words and every model cleared
 * it, so planning evidence was one run per cheap model with no signal. Each
 * task here has a property a plan can get wrong and a verifier that detects
 * exactly that property.
 */
import type { BenchmarkTask } from "./types.ts";
import { verifyMigrationPlan, verifyIncidentRunbook } from "./planning-verifiers.ts";

export const PLANNING_TASKS: BenchmarkTask[] = [
  {
    // Failure mode: dropping the old column in the same release that stops
    // writing to it, which breaks an instance still on the previous release.
    id: "plan_expand_contract",
    name: "Plan a backwards-compatible column split across releases",
    kind: "planning",
    prompt:
      "Write a migration plan in `migration-plan.md` to split the `users.full_name` column into `first_name` and `last_name`. " +
      "Hard constraint: two releases run side by side during every deploy, so every step must keep working while the previous release is still serving traffic. " +
      "The plan must be a numbered sequence of steps grouped by release. It must add the new columns, dual-write both old and new during the transition, " +
      "backfill existing rows, switch reads, stop writing the old column, and drop the old column. " +
      "State explicitly which release each step belongs to, and include a rollback section.",
    setupFiles: {},
    customVerifier: verifyMigrationPlan,
  },
  {
    // Failure modes: a step with no owner, a step that depends on a later
    // one, and warming the cache before the database is confirmed healthy.
    id: "plan_incident_decomposition",
    name: "Decompose a multi-system incident into owned, ordered steps",
    kind: "planning",
    prompt:
      "A network partition has degraded four systems: the database, the message queue, the API gateway, and the cache. " +
      "Write an incident runbook in `incident-runbook.md`. " +
      "Requirements: a numbered list of at least five recovery steps in the order they must run; every step ends with `Owner: <role>`; " +
      "every one of the four systems is addressed by at least one step; no step may depend on a step that comes after it; " +
      "the cache must not be warmed or repopulated until the database has been confirmed healthy; " +
      "include a verification step that is not first, and a Rollback section.",
    setupFiles: {},
    customVerifier: verifyIncidentRunbook,
  },
];
