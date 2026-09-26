# Migration Plan: Split `users.full_name` into `first_name` / `last_name`

## Constraint and ground rules

**Hard constraint:** during every deploy, release N and release N-1 serve traffic side by side. So every schema change and every code change must work with both the release before it and the release after it.

Rules that follow from this:

1. **Migrations run before code rollout.** Each release's schema migration runs while the *previous* release is still serving all traffic, so the migration must be safe for that previous release's code.
2. **Each release changes one thing at a time.** Schema expansion, write path, read path, write removal, and schema contraction ship in separate releases.
3. **Never start the next release until the current one is at 100%** and no instance of the older release is left (check the deploy dashboard or instance version metrics).
4. **Rollbacks go back one release at a time.** The target is always the release that was just running side by side with the current one, so it is known to be compatible.
5. **Canonical split rule** (used by application code *and* the SQL backfill, and covered by a shared test fixture):
   - Normalize: trim the value and collapse runs of whitespace to a single space.
   - `first_name` = the text before the first space.
   - `last_name` = everything after the first space, or `''` if there is none.
   - Reverse rule (used later for `full_name`): `full_name = trim(first_name || ' ' || last_name)`.
   - Examples: `"Ada Lovelace"` → (`Ada`, `Lovelace`); `"Cher"` → (`Cher`, `''`); `"  Mary   Ann  Smith "` → (`Mary`, `Ann Smith`); `NULL` → (`NULL`, `NULL`).

SQL examples below are PostgreSQL.

---

## Steps by release

### Release 0: Current production (baseline, no changes)

Reads and writes only `full_name`. Nothing to deploy. Listed here only so the compatibility checks below have a baseline.

**Step 0 (prep, before Release 1):** List every reader and writer of `users.full_name`: application code, raw SQL, ORM models, views, triggers, reporting/ETL jobs, search indexes, CDC/analytics consumers, and read replicas. Each one needs a matching change in the release where its behavior changes (reads in Release 3, writes in Release 4, and it must be gone before Release 5).

### Release 1: Expand the schema (add new columns)

**Step 1 (Release 1, migration):** Add nullable columns with no default and no constraints:

```sql
ALTER TABLE users ADD COLUMN first_name text NULL;
ALTER TABLE users ADD COLUMN last_name  text NULL;
```

- Metadata-only in PostgreSQL (no table rewrite, brief lock). Run with a `lock_timeout` so it gives up instead of queueing behind long transactions.
- **Compatible with Release 0:** Release 0 never references the columns. Its INSERTs leave them `NULL`, which is allowed. If the ORM caches column lists or uses `SELECT *` with strict mapping, confirm it ignores unknown columns.

**Step 2 (Release 1, code):** Add `first_name` / `last_name` to the model as read-only/unused fields, plus the canonical split/join helpers and their tests. No behavior change: reads and writes still use `full_name` only.

- **Compatible with Release 0:** same behavior, same data.

### Release 2: Dual-write (old and new columns)

**Step 3 (Release 2, code):** Every code path that creates or updates a user's name writes **all three** columns in the same statement/transaction:
- If the input is `full_name`: store it, and store `first_name`/`last_name` derived with the split rule.
- If the input is `first_name`/`last_name` (new API shape, accepted from this release on but not yet used by clients): store them, and store `full_name` derived with the join rule.
- **Reads still come from `full_name`.**

- **Compatible with Release 1 (running side by side):** Release 1 reads `full_name`, which Release 2 keeps correct. Release 1 still writes only `full_name`, so rows it creates or updates during the rollout have `NULL` or stale new columns. That's expected, and Step 4 fixes it.
- Clients (frontend, mobile, integrations) must keep sending `full_name` until Release 3, because a request can hit a Release 1 instance that doesn't understand the new shape.

**Step 4 (Release 2, backfill; run only after Release 2 is at 100% and no Release 1 instance is left):** Recompute the new columns from `full_name` for all rows, in batches:

```sql
-- Repeat for successive id ranges (e.g. 5–10k rows per batch), pausing between batches.
UPDATE users
SET first_name = split_part(btrim(regexp_replace(full_name, '\s+', ' ', 'g')), ' ', 1),
    last_name  = coalesce(substring(btrim(regexp_replace(full_name, '\s+', ' ', 'g')) FROM '^\S+ (.*)$'), '')
WHERE id >= :lo AND id < :hi
  AND full_name IS NOT NULL
  AND (first_name IS DISTINCT FROM split_part(btrim(regexp_replace(full_name, '\s+', ' ', 'g')), ' ', 1)
    OR last_name  IS DISTINCT FROM coalesce(substring(btrim(regexp_replace(full_name, '\s+', ' ', 'g')) FROM '^\S+ (.*)$'), ''));
```

- **Why it has to wait for 100%:** while Release 1 is still serving, it can create rows or update `full_name` without touching the new columns. Once only Release 2 is writing, every write keeps all three columns consistent, so a single backfill pass is final.
- **Race-safe:** each row is recomputed from its *current* `full_name` inside one `UPDATE`, so a concurrent Release 2 write can't be overwritten with stale data.
- **Idempotent and resumable:** the `IS DISTINCT FROM` filter skips rows that are already correct, so the job can be re-run at any time.
- Watch replication lag and lock waits, and throttle batches if either rises.

**Step 5 (Release 2, verification gate):** Reconciliation must return 0 before Release 3 starts:

```sql
SELECT count(*) FROM users
WHERE (full_name IS NULL) <> (first_name IS NULL)
   OR btrim(regexp_replace(full_name, '\s+', ' ', 'g')) IS DISTINCT FROM btrim(first_name || ' ' || last_name);
```

Keep running this check (for example as a scheduled job with an alert) until Release 4 ships.

### Release 3: Switch reads to the new columns (keep dual-write)

**Step 6 (Release 3, migration, optional hardening):** Once the Step 5 check is at 0, add constraints without a long lock. It's safe because the only writer (Release 2) already fills the new columns:

```sql
ALTER TABLE users ADD CONSTRAINT users_first_name_present
  CHECK (full_name IS NULL OR first_name IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_first_name_present;
```

**Step 7 (Release 3, code):** All reads (display, search, sorting, serializers, exports) use `first_name` / `last_name`. Where a combined display name is needed, build it with the join rule. Dual-write from Step 3 stays unchanged: `full_name` is still written on every name change. Readers found in Step 0 (reports, ETL, views, search index) switch over in this release too.

- **Compatible with Release 2 (running side by side):** Release 2 reads `full_name`, and Release 3 still writes it correctly. Release 3 reads the new columns, which Release 2 writes correctly. Both releases write all three columns, so data stays consistent whichever instance handles a request.
- Clients may start sending the `first_name` / `last_name` input shape once Release 3 is at 100%. Release 2 already accepts it (Step 3), so client/server version skew is safe.

### Release 4: Stop writing the old column

**Step 8 (Release 4, migration; runs while Release 3 is serving):** Make the old column optional so that inserts that omit it will succeed:

```sql
ALTER TABLE users ALTER COLUMN full_name DROP NOT NULL;   -- skip if already nullable
-- also drop any DEFAULT, trigger, index, or view that depends on full_name and is no longer needed
```

- **Compatible with Release 3:** Release 3 always supplies `full_name` anyway.

**Step 9 (Release 4, code):** Remove every write to `full_name`. Remove the column from the ORM model, and mark it ignored (e.g. Rails `ignored_columns`, or an explicit column list) so that no generated `SELECT` or `INSERT` references it. Remove the `full_name` input shape from the API, or keep accepting it and translate it into `first_name` / `last_name` only.

- **Compatible with Release 3 (running side by side):** Release 3 reads only `first_name` / `last_name`, which Release 4 writes. Release 3 still writes `full_name` too, which is harmless. From here on `full_name` gets stale or `NULL` for rows written by Release 4, and nothing reads it any more.
- **This is the first point of no easy return** (see Rollback).

### Release 5: Contract the schema (drop the old column)

**Step 10 (Release 5, pre-drop check):** Confirm there are no remaining references: code search for `full_name`, `pg_stat_statements` shows no queries touching it, and no dependent views, triggers, indexes, or replication/CDC consumers are left. Take a backup/snapshot of `users (id, full_name)` and keep it for the agreed retention period.

**Step 11 (Release 5, migration; runs while Release 4 is serving):**

```sql
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_first_name_present;  -- re-add a new-columns-only constraint if desired
ALTER TABLE users DROP COLUMN full_name;
```

- **Compatible with Release 4:** Release 4 never reads, writes, or selects `full_name` (it is ignored in the ORM).

**Step 12 (Release 5, code):** Remove the `ignored_columns` entry, the dual-write/translation helpers, and the reconciliation job. Optionally add final constraints on the new columns (e.g. `first_name NOT NULL`, using `NOT VALID` then `VALIDATE`).

- **Compatible with Release 4:** neither release references `full_name`.

---

## Side-by-side compatibility matrix

| Deploy window         | Schema at that time             | Older release reads / writes             | Newer release reads / writes             | Safe because                                   |
|-----------------------|---------------------------------|-------------------------------------------|-------------------------------------------|------------------------------------------------|
| R0 → R1               | old + new (nullable)            | full_name / full_name                     | full_name / full_name                     | new columns are unused and nullable            |
| R1 → R2               | old + new                       | full_name / full_name                     | full_name / all three                     | both read full_name; gaps fixed by backfill    |
| R2 → R3               | old + new (backfilled)          | full_name / all three                     | new / all three                           | both write all three columns                   |
| R3 → R4               | old (nullable) + new            | new / all three                           | new / new only                            | nobody reads full_name any more                |
| R4 → R5               | new only (after drop)           | new / new only                            | new / new only                            | neither release references full_name           |

---

## Rollback

General rule: roll back one release at a time, to the release that was just running side by side with the current one. Code rollbacks are safe without schema changes up to and including Release 3. From Release 4 onward, going back further needs a data repair first.

| Rolling back                  | Action                                                                                                   | Data impact / extra steps |
|-------------------------------|----------------------------------------------------------------------------------------------------------|---------------------------|
| **Release 1 → Release 0**     | Redeploy Release 0. Leave the new columns in place (harmless). Optionally drop them later in a separate change. | None. |
| **Release 2 → Release 1**     | Redeploy Release 1. Pause/abort the backfill (Step 4) if it's running.                                   | New columns go stale while Release 1 serves. Harmless, because nothing reads them. When Release 2 is re-deployed, re-run Step 4 **after** it reaches 100% again, then Step 5. |
| **Release 3 → Release 2**     | Redeploy Release 2. Leave the Step 6 constraint in place (Release 2 satisfies it).                      | None. Both releases write all three columns, so `full_name` is current and Release 2 reads it. |
| **Release 4 → Release 3**     | Redeploy Release 3. Leave `full_name` nullable.                                                         | Release 3 reads only the new columns, so it works right away. Rows written by Release 4 have a `NULL`/stale `full_name`. **Before rolling back further to Release 2**, run a reverse backfill once Release 3 is at 100%: `UPDATE users SET full_name = btrim(first_name || ' ' || last_name) WHERE first_name IS NOT NULL AND full_name IS DISTINCT FROM btrim(first_name || ' ' || last_name)` (batched), then re-run Step 5. |
| **Release 5 → Release 4**     | Code rollback only. Release 4 doesn't use `full_name`, so it runs fine on the post-drop schema.        | None for Release 4. |
| **Undoing the drop** (needed only to go back to Release 3 or earlier) | Treat it as a new forward migration: `ADD COLUMN full_name text NULL`, reverse backfill from `first_name`/`last_name` (as above), confirm with Step 5, then deploy the older code one release at a time. | Original raw values (e.g. extra whitespace, name formats the split rule changed) can only be recovered from the Step 10 snapshot. Restore from it if exact values matter. |

**Rollback triggers to watch at each step:** error rate or latency regressions on user endpoints, the Step 5 check going above 0, failed inserts/updates on `users`, replication lag during the backfill, and support reports of wrongly displayed names (split-rule edge cases). A split-rule bug found after Release 3 should normally be fixed *forward* (correct the rule, re-run the idempotent backfill for affected rows), not rolled back.
