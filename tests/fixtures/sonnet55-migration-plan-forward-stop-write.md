# Migration plan: split `users.full_name` into `first_name` and `last_name`

## Constraints and assumptions

- **Two releases always overlap during a deploy.** Release N (new) and N-1 (old) both serve traffic and both talk to the same database. Every step must be safe with the previous release still running, and every release must be safe to roll back to the one before it.
- Schema changes run **before** the code that needs them. Code that stops using something ships **before** the schema change that removes it.
- SQL is PostgreSQL syntax. Adapt it for another database, but keep the ordering.
- Today: `users.full_name` is `NOT NULL` (assumed). All code reads and writes only `full_name`.
- **Split rule (decide once, share everywhere):** `first_name` is the first whitespace-delimited token. `last_name` is the rest, trimmed. A single-token name gives `last_name = ''`, never `NULL`. The inverse is `full_name = trim(first_name || ' ' || last_name)`. Implement this as one shared function used by the application dual-write, the backfill and the verification query, so they cannot drift.
- Other consumers of `full_name` (reports, exports, search indexes, analytics, BI, other services, DB views) are inventoried in step 1. Each one must be migrated before step 18 (the drop).

## Overview

| Release | Purpose | Reads | Writes | Schema change |
|---|---|---|---|---|
| **R0** (today) | baseline | `full_name` | `full_name` | none |
| **R1** | Expand + dual-write | `full_name` | `full_name` + new columns | add nullable `first_name`, `last_name` |
| *(between R1 and R2)* | Backfill | n/a | n/a | data only |
| **R2** | Switch reads | new columns | `full_name` + new columns | make `full_name` nullable |
| **R3** | Stop writing old column | new columns | new columns only | none (code ignores `full_name`) |
| **R4** | Contract | new columns | new columns only | drop `full_name`, add `NOT NULL` on new columns |

Why each release is separate:

- **R1 and R2 are separate** because reads cannot move until the backfill is complete. The backfill cannot be completed until no R0 instance is left, since R0 writes rows without the new columns.
- **R2 and R3 are separate** because during the R2 rollout R1 instances still *read* `full_name`. If R2 stopped writing it, R1 would serve stale names.
- **R3 and R4 are separate** because during the R3 rollout R2 instances still *write* `full_name`. Dropping the column would make those writes fail.

---

## Release 1: Expand and dual-write

Compatibility: R0 ignores the new columns, which is harmless because they are nullable with no default. R1 works while R0 is still running.

1. **[Prep, no release] Inventory consumers.** Grep code, ORM models, serializers, raw SQL, views, triggers, ETL jobs, search indexes and other services for `full_name`. Record each one and its owner. Add a log line or DB comment to help find dynamic readers.
2. **[R1, migration, runs before the code rolls out] Add the columns.**
   ```sql
   SET lock_timeout = '3s';
   ALTER TABLE users ADD COLUMN first_name text;
   ALTER TABLE users ADD COLUMN last_name  text;
   ```
   - Nullable, no default, so it is a metadata-only change with no table rewrite.
   - Do not add `NOT NULL`, a default, or an index yet. R0 inserts would fail or leave rows unusable.
   - Retry on lock timeout instead of queueing behind long transactions.
3. **[R1, code] Dual-write.** Every code path that creates or updates a user's name computes both representations with the shared split function and writes `full_name`, `first_name` and `last_name` in the same statement or transaction. `full_name` stays the source of truth: if the input is a single name string, split it. If the input is already two fields, recompose `full_name`.
4. **[R1, code] Reads stay on `full_name`.** No read path changes, because R0 rows do not yet have the new columns.
5. **[R1, deploy] Roll out R1 to 100%** and confirm no R0 instance remains. This includes web, workers, cron and job runners, and any long-lived consumers such as queue workers. **Gate:** do not start the backfill until R0 is fully gone. Any R0 process still running can write a row that leaves the new columns null or stale.

## Between R1 and R2: Backfill

6. **[Data, after step 5] Backfill in batches.** Run an idempotent, resumable job keyed on primary-key ranges, for example 1,000 to 10,000 rows per batch with a short sleep and replica-lag checks:
   ```sql
   UPDATE users
   SET first_name = <split_first(full_name)>,
       last_name  = <split_last(full_name)>
   WHERE id BETWEEN :lo AND :hi
     AND (first_name, last_name) IS DISTINCT FROM
         (<split_first(full_name)>, <split_last(full_name)>);
   ```
   - The predicate is "differs from what the split would produce", **not** `first_name IS NULL`. During the R0/R1 overlap, R0 may have updated `full_name` on a row that R1 had already dual-written, leaving stale non-null values.
   - Safe to run concurrently with R1's dual-writes: both write the same derived values. The job never touches `full_name`.
   - Do not run it as one large transaction.
7. **[Data] Verify.** Run until this returns 0, then run it again after a delay:
   ```sql
   SELECT count(*) FROM users
   WHERE (first_name, last_name) IS DISTINCT FROM
         (<split_first(full_name)>, <split_last(full_name)>);
   ```
   Also check `count(*) WHERE first_name IS NULL OR last_name IS NULL` is 0, and spot-check unusual names (single token, multiple spaces, non-ASCII, empty string). Record the results in the release ticket. **Gate:** R2 does not ship until the count is 0. Because R1 dual-writes, it should stay 0.

## Release 2: Switch reads

Compatibility: R1 still reads `full_name`, and R2 keeps writing it, so both see correct data.

8. **[R2, migration, before the code] Make `full_name` nullable.**
   ```sql
   ALTER TABLE users ALTER COLUMN full_name DROP NOT NULL;
   ```
   Metadata-only, and safe for R1, which always supplies a value. This is done now so that R3 can stop writing the column. Doing it in R2 means it is already in place when R3 instances start.
9. **[R2, code] Switch all reads to `first_name` / `last_name`.** Display names are composed from the new columns (`trim(first || ' ' || last)`). Update the read-side consumers found in step 1. Queries, search and sorting move to the new columns. Add any index the new access pattern needs (`CREATE INDEX CONCURRENTLY`, in a separate non-transactional migration, before the code).
10. **[R2, code] Keep dual-writing** `full_name`, `first_name` and `last_name` exactly as in R1. It must continue because R1 instances are still serving reads from `full_name` during the rollout, and because it keeps R1 a valid rollback target.
11. **[R2, deploy] Roll out R2 to 100%.** Watch error rates, name-related bugs and the step 7 verification query for at least one full traffic cycle (recommended: at least 24 hours, plus one full business cycle if traffic is periodic).

## Release 3: Stop writing the old column

Compatibility: R2 reads only the new columns and writes both, so it is unaffected by R3 no longer writing `full_name`. Step 8 already made the column nullable, so R3's inserts succeed.

12. **[R3, code] Write only `first_name` and `last_name`.** Remove `full_name` from all inserts and updates. Do not rely on a column default or trigger to fill it.
13. **[R3, code] Make the application ignore `full_name`.** Remove it from models, serializers and factories. Where the ORM caches column lists or uses `SELECT *` with prepared statements, mark the column as ignored (for example Rails `ignored_columns`) so that dropping it in R4 cannot break running processes.
14. **[R3, prep] Confirm no remaining readers.** Re-run the step 1 inventory. Check DB-side usage (`pg_stat_statements`, slow-query and audit logs) for any query that still mentions `full_name` over a full cycle, and migrate any straggler consumers.
15. **[R3, deploy] Roll out R3 to 100%.** From now on, `full_name` values go stale as rows are created or edited.
16. **[R3, soak] Wait** at least one full release cycle (recommended: a week or more) with `full_name` unread and unwritten. This is the last point where rolling back to R1 is cheap; see the rollback section.

## Release 4: Contract

Compatibility: R3 does not reference `full_name`, so dropping it is invisible to R3 and to any R4 instance.

17. **[Prep] Archive.** Before the destructive step, snapshot the table or export `id, full_name` to cold storage, and note the retention period. The drop is not reversible in place.
18. **[R4, migration, after R3 is at 100%] Drop the old column and tighten the new ones.**
    ```sql
    SET lock_timeout = '3s';
    ALTER TABLE users DROP COLUMN full_name;
    ```
    Then tighten the constraints, which is only safe now that the verification is complete and every writer (R3+) supplies both fields. Use the `NOT VALID` then `VALIDATE` pattern to avoid a long lock:
    ```sql
    ALTER TABLE users ADD CONSTRAINT users_first_name_nn CHECK (first_name IS NOT NULL) NOT VALID;
    ALTER TABLE users VALIDATE CONSTRAINT users_first_name_nn;
    -- same for last_name; then optionally SET NOT NULL and drop the CHECK
    ```
19. **[R4, code] Remove leftovers:** the shared split helper's dual-write branch, the `ignored_columns` entry, feature flags and the backfill job. Deploy as R4 (or with it).
20. **[R4, deploy] Roll out R4 and close out.** Remove the archive after its retention period.

---

## Rollback

General rule: **roll back code first, and never roll back a schema change that a running release depends on.** Because each release only adds compatibility, rolling back one release is always possible while the previous release's schema needs are still met.

| Situation | Action | Data effect |
|---|---|---|
| **R1 fails** (before or during rollout) | Redeploy R0. Leave the new columns in place (they are harmless), or `DROP COLUMN` both if desired. Stop the backfill if it has started. | None. `full_name` was always written and is complete. |
| **Backfill misbehaves** (load, lag, bad data) | Pause or kill the job. It is idempotent, so re-run it after fixing the split function. If the split rule was wrong, fix it and re-run. | The new columns can be recomputed from `full_name` at any time. `full_name` is never modified. |
| **R2 fails** | Redeploy R1. R1 reads `full_name`, which R2 kept current. The `DROP NOT NULL` from step 8 can stay, since R1 always supplies a value. | None. |
| **R3 fails or a hidden reader of `full_name` appears** | Redeploy R2, which reads the new columns and is unaffected by stale `full_name`. This is a safe one-step rollback. Rows written by R3 have a stale or null `full_name`. | Nothing is lost, because the new columns are the truth. |
| **Roll back further, to R1 or R0, after R3 has run** | First repair `full_name` from the new columns: `UPDATE users SET full_name = trim(first_name \|\| ' ' \|\| last_name) WHERE full_name IS DISTINCT FROM trim(first_name \|\| ' ' \|\| last_name)`, run in batches. Then redeploy R2 first, then R1. If R0 is required, re-add `NOT NULL` on `full_name` only after the repair and only after no R2/R3 instance can insert without it. | `full_name` is rebuilt losslessly (up to whitespace normalization). |
| **R4 fails after the column is dropped** | Redeploy R3 (it does not use `full_name`). If an older release must be restored, re-create the column and restore it: `ALTER TABLE users ADD COLUMN full_name text;` then recompute it from the new columns as in the row above, or restore from the step 17 archive for exact original strings. | Exact original strings are only recoverable from the archive. Keep it until R4 is stable. |

Rollback preconditions and rules:

- **Point of no return:** step 18. Before it, every step is reversible with no data loss. After it, restoring the exact original `full_name` strings requires the step 17 archive. This is why steps 16 and 17 come first.
- **Do not skip releases when rolling back.** Roll back in reverse order (R4, R3, R2, R1) so that each running release's assumptions are still met.
- **Never roll back the R1 schema (dropping the new columns) while R1 or later is running.**
- Each release deploy should be reversible independently: keep migrations and application deploys as separate pipeline steps, so a code rollback does not implicitly revert a migration.
- Rollback triggers: a rise in 5xx or DB errors, name display or search regressions, a non-zero verification query after step 7, replication lag or lock waits beyond agreed limits during a migration or backfill.

## Checklist summary

- [ ] R1: columns added, dual-write live, R0 fully drained (steps 2–5)
- [ ] Backfill complete and verification query returns 0 (steps 6–7)
- [ ] R2: `full_name` nullable, reads switched, dual-write kept (steps 8–11)
- [ ] R3: writes to `full_name` stopped, column ignored, no readers remain (steps 12–16)
- [ ] R4: archive taken, `full_name` dropped, constraints tightened, code cleaned up (steps 17–20)
