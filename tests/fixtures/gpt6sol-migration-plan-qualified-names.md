# Migration plan: split `users.full_name`

**Deployment rule:** A release always overlaps the immediately preceding release. Do not deploy the next release until the preceding rollout is complete and any stated data gate has passed. Keep `full_name` as the source of truth until Release 3. Use one documented, deterministic splitting rule for application writes and backfill (including null, single-part, multi-part, and unusual names); review ambiguous names rather than assuming the split is always correct. Test that rule and the application against both schema versions at each boundary.

## Release 1 — expand the schema (overlaps Release 0)

1. **Release 1, before deploying its application:** Add nullable `users.first_name` and `users.last_name` columns. Leave `users.full_name` and its existing constraints in place; do not require values in the new columns yet. Release 0 continues to read and write `full_name` normally.
2. **Release 1 application:** Continue reading and writing `full_name` only. Confirm Release 0 and Release 1 both work on the expanded schema. Wait for Release 0 to drain before the next deploy.

## Release 2 — dual-write and backfill (overlaps Release 1)

3. **Release 2 application:** Continue reading `full_name`. On every user create or name change, write `full_name`, `first_name`, and `last_name` together in one transaction using the same split rule. Keep `full_name` valid for Release 1, which still writes only that column. Include all write paths (API, jobs, imports, admin tools).
4. **Release 2 data operation:** Backfill the new columns in small, restartable batches from `full_name`, without blocking normal writes for the duration of the job. Because Release 1 can still update *previously backfilled* rows using only `full_name`, do not treat the first pass or a null-only check as sufficient.
5. **Release 2 gate, after Release 1 and its in-flight requests have drained:** Reconcile **every** row whose new columns do not match the split of its current `full_name`, including non-null stale values. Use row-level locking/transactional updates (or equivalent concurrency-safe compare-and-retry) so the reconciliation cannot overwrite a concurrent Release 2 name change. Repeat until all rows match; verify counts and spot-check ambiguous names. Keep Release 2 dual-writing. Only then start Release 3.

## Release 3 — switch reads (overlaps Release 2)

6. **Release 3 application:** Read `first_name` and `last_name` instead of `full_name` on all paths, but **continue atomic dual-writes** to all three columns. Release 2 still reads `full_name`, so it needs the old value kept current. Do not enable new-column-only reads until step 5 passes and Release 1 is fully gone. Monitor mismatches and read errors; wait for Release 2 to drain before proceeding.

## Release 4 — stop writing the old column (overlaps Release 3)

7. **Release 4, before deploying its application:** If `full_name` is required (`NOT NULL`, validation, or write-dependent triggers), relax those requirements so new-column-only inserts can succeed. Keep the column in place; Release 3 still writes it while serving traffic.
8. **Release 4 application:** Read and write only `first_name` and `last_name`; stop writing `full_name` on every path. Release 3 reads the new columns, so it remains functional while it overlaps Release 4. Treat `full_name` as potentially null or stale from this point onward. Verify no remaining readers or writers depend on it, and wait for Release 3 to drain.

## Release 5 — contract the schema (overlaps Release 4)

9. **Release 5, before deploying its application:** After confirming Release 3 is gone and Release 4 uses only the new columns, drop `users.full_name` and its old-column-specific indexes/constraints. Use the database's safe online DDL procedure where available. Release 4 must continue functioning throughout the schema change.
10. **Release 5 application:** Continue reading and writing only the new columns; monitor errors and completeness. Add any desired new-column constraints only after validating the intended null/name policy and ensuring the constraint change is compatible with Release 4.

## Rollback

- **Release 1:** Revert the application without dropping the added columns while any Release 1 instances run; remove columns only if no later release or backfill uses them.
- **Release 2:** Revert to Release 1 while `full_name` remains authoritative. Leave the new columns in place; rerun the full reconciliation in step 5 before attempting Release 3 again.
- **Release 3:** Revert to Release 2 while dual-writes still keep `full_name` current. Investigate/fix discrepancies before retrying the read switch.
- **Release 4:** Revert to Release 3 (which reads the new columns and resumes dual-writing) while `full_name` still exists. **Do not** roll back to Release 2/older, which read `full_name`, without first rebuilding `full_name` from the authoritative new columns and verifying it; Release 4 may have left it stale.
- **Release 5:** Roll back application code only to Release 4, which does not use `full_name`. Dropping the column is a schema/data rollback boundary: to return to Release 3 or older, re-add `full_name`, reconstruct it from the new columns under a defined join policy, validate it, and restore required constraints before deploying any old-column-dependent code. Use a pre-drop backup if exact historical formatting is needed; it may not be recoverable from a split name.
