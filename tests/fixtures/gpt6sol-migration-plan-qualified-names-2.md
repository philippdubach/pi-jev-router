# Migration plan: `users.full_name` → `users.first_name`, `users.last_name`

**Deployment rule:** Every release overlaps with the immediately preceding release. Deploy schema changes only when *both* versions that may be serving traffic can use that schema. Do not advance to the next release until the current release is fully deployed, its predecessor is drained (including workers and background jobs), and the stated data checks pass. `R0` is the existing application, which reads and writes `full_name`.

Before implementation, agree on a split policy for ambiguous names (including single-word names and null/blank values), the corresponding display/join policy, and how exceptions will be reviewed. A generic whitespace split is not reliably reversible. Include every writer and reader of `users` (APIs, jobs, imports, and direct SQL) in the release inventory. During dual-write, update the old and new representations **atomically in the same transaction** whenever name data changes; partial or unrelated updates must not overwrite a name with stale values.

## Release R1 — expand and dual-write; keep old reads

1. **R1, before application rollout:** Add nullable `users.first_name` and `users.last_name` columns. Leave `full_name` and its existing constraints intact. `R0` can still read/write exactly as before.
2. **R1, application rollout:** Read `full_name`, but write `full_name`, `first_name`, and `last_name` together for every name insert/change. Derive values from the incoming name using the agreed policy, regardless of whether the request supplies the old or new representation. While `R0` and `R1` overlap, do not read the new columns as authoritative: `R0` can still write only `full_name`.
3. **R1, after `R0` is drained:** Backfill **all** existing rows from the current `full_name`, not just rows with null new columns: an `R0` write during rollout may have left non-null new columns stale. Use small, restartable batches with row locks or equivalent concurrency-safe updates so the backfill cannot overwrite a concurrent `R1` name change. Review parsing exceptions; reconcile and verify every row against the agreed split policy, and verify all active writers now dual-write. Keep dual-writing for the next release.

## Release R2 — switch reads; keep dual-writing

4. **R2, rollout only after step 3 passes:** Switch application reads and display/search logic to `first_name` and `last_name`. Continue writing all three columns atomically. `R1` still reads `full_name`, so both versions see current names while they overlap. Monitor for missing or inconsistent new-column values; pause or roll back rather than silently discarding names.
5. **R2, after `R1` is drained:** Confirm all remaining readers use the new columns and all writers still update both representations. Reconcile discrepancies before proceeding. Treat the new columns as the source of truth from this point onward.

## Release R3 — stop writing the old column

6. **R3, before application rollout:** Remove any `full_name` NOT NULL requirement (and other insert/update constraints requiring an old-column value), while retaining the column. `R2` remains compatible because it still supplies `full_name`. Verify that inserts with only the new name columns succeed.
7. **R3, application rollout:** Read and write only `first_name` and `last_name`; stop populating or updating `full_name`. The overlapping `R2` reads the new columns and may continue dual-writing, so neither version requires `full_name` to stay current. Once `R2` is drained, confirm no application, job, import, query, or dependency reads or writes `full_name`.

## Release R4 — contract

8. **R4, application rollout:** Keep all reads and writes on the new columns only. `R3` and `R4` must both work without `full_name`; verify this across all deployed processes before the schema change.
9. **R4, after verifying step 8:** Drop `users.full_name` and old-column indexes/constraints. This is safe even if `R3` is still serving traffic, because neither `R3` nor `R4` accesses it. Validate production reads, writes, and background jobs after the drop.

## Rollback

- **Before R3:** Keep `full_name`. Rolling `R2` back to `R1` is safe because both releases dual-write; `R1` reads the still-current old column. Rolling `R1` back to `R0` is safe for old-column operations, but `R0` does not maintain the new columns. Repeat the full R1 backfill/reconciliation after `R0` is drained again, before retrying R2.
- **During/after R3, before the drop:** A rollback to `R2` is possible while `full_name` exists: `R2` reads the new columns and resumes dual-writing. Before rolling back further to `R1` or `R0`, drain every `R3` (new-only) writer, restore `full_name` for every row from the new columns using the agreed join policy, and validate it while `R2` keeps dual-writing. Never run an old-column reader alongside a new-only writer. Do not reinstate NOT NULL until all rows have valid old-column values and all running versions can satisfy it.
- **After the drop:** Rolling `R4` back to `R3` is safe: neither uses `full_name`. **Do not roll back to `R2` or earlier directly.** First re-add nullable `full_name` before starting any old-column writer. `R2` can then overlap with `R3`/`R4` because it reads the new columns. To go back to `R1` or `R0`, drain all new-only writers, repopulate `full_name` from the new columns while `R2` dual-writes, and validate it before starting an old-column reader; restore any required constraints only when all rows and running versions satisfy them. Re-adding the column cannot recover an ambiguous original spelling or formatting; use backups if exact historical `full_name` values are required.
