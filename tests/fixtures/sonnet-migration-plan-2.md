# Migration Plan: Split `users.full_name` into `first_name` and `last_name`

## Context & Constraint

Deploys run two releases side by side (rolling/blue-green deploy). At every
point in time, **both the outgoing release (N) and the incoming release
(N+1) are serving live traffic against the same database**. This means:

- A schema change deployed with release N must not break release N-1 still
  in flight, and must not break release N+1 about to roll out.
- No single deploy may both change the schema *and* require the app to stop
  reading/writing a column that the previous release still depends on.
- We use the classic **expand → migrate → contract** pattern, spread across
  multiple releases, each of which is independently safe to run alongside
  its immediate predecessor/successor.

Column being split: `users.full_name` (existing, `NOT NULL`)
New columns: `users.first_name`, `users.last_name`

---

## Release N: Expand — add new columns (schema only, no behavior change)

Goal: add the new columns without any application code depending on them
yet, so this schema change is compatible with the currently-running release
N-1 (which knows nothing about them) and sets up for N+1.

1. **[Release N]** Add migration: `ALTER TABLE users ADD COLUMN first_name VARCHAR(255) NULL;`
2. **[Release N]** Add migration: `ALTER TABLE users ADD COLUMN last_name VARCHAR(255) NULL;`
   - Both columns nullable, no default, no `NOT NULL` constraint yet — safe for old rows and safe if release N-1 is still inserting rows without them.
3. **[Release N]** Deploy application code that:
   - Defines `first_name`/`last_name` in the ORM/model layer as optional fields.
   - Does **not yet** read or write them anywhere in business logic (no-op addition). This keeps N fully compatible with N-1 traffic during the rollout, since N-1 never touches the new columns and N doesn't require them to be populated.
4. **[Release N]** Verify deploy: confirm schema change applied on all replicas/nodes and app boots cleanly with both old release (N-1, ignorant of new columns) and new release (N) running concurrently.

---

## Release N+1: Dual-write — write both old and new columns

Goal: start populating `first_name`/`last_name` on every write, while
continuing to write `full_name` exactly as before, so reads (from any
release, old or new) remain correct.

5. **[Release N+1]** Add a pure helper function `splitFullName(fullName) -> (first, last)` (and, if needed, `joinName(first, last) -> full_name`) used only for the write path.
6. **[Release N+1]** Update all write paths (create/update user) to:
   - Continue writing `full_name` as the source of truth (unchanged behavior).
   - Additionally derive and write `first_name` and `last_name` from the same input on every insert/update.
   - This is backward compatible: release N (still running side-by-side) only writes/reads `full_name`, which is still fully maintained, so no data is lost or stale for rows touched by either release during the overlap window.
7. **[Release N+1]** Reads still use `full_name` exclusively (no behavior change on the read path yet).
8. **[Release N+1]** Deploy and verify: monitor writes to confirm `first_name`/`last_name` are populated correctly for all newly created/updated rows during the N ↔ N+1 overlap.

---

## Release N+2: Backfill — populate new columns for existing rows

Goal: fill in `first_name`/`last_name` for rows written before dual-write
began (Release N+1), without touching `full_name` or read behavior.

9. **[Release N+2]** Run an idempotent, batched, throttled backfill job (offline/async, e.g. background worker or migration script) that:
   - Selects rows where `first_name IS NULL OR last_name IS NULL`.
   - Computes `first_name`/`last_name` from `full_name` using the same `splitFullName` logic.
   - Updates rows in small batches (e.g. by primary key range) to avoid long locks/replication lag.
   - Is safe to re-run and safe to run concurrently with live dual-writes from Release N+1 (only updates rows not already backfilled; uses `WHERE` guard to avoid clobbering newer writes — e.g. only update if `first_name IS NULL`).
10. **[Release N+2]** No application code change required for this release; the app code deployed is functionally identical to N+1 (still dual-writing, still reading `full_name`). This keeps the release safe to run next to N+1 during the deploy overlap.
11. **[Release N+2]** Verify backfill completion: run a validation query confirming `SELECT COUNT(*) FROM users WHERE first_name IS NULL OR last_name IS NULL` returns 0 (excluding any legitimately-empty names, handled explicitly).

---

## Release N+3: Switch reads to new columns

Goal: start reading from `first_name`/`last_name` instead of `full_name`,
now that all rows (old + new) are guaranteed to have them populated.

12. **[Release N+3]** Update all read paths to construct the display name from `first_name` + `last_name` (e.g. `first_name + ' ' + last_name`) instead of reading `full_name`.
13. **[Release N+3]** Keep the dual-write from Release N+1 fully intact (still writing `full_name`, `first_name`, `last_name` on every write). This is required because Release N+2 (previous release, still serving traffic during overlap) still reads `full_name` — so `full_name` must remain correct and current.
14. **[Release N+3]** Deploy and verify: confirm reads render correctly from the new columns while `full_name` continues to be maintained in the background for compatibility with the previous release during rollout.

---

## Release N+4: Contract — stop writing the old column

Goal: stop writing `full_name`, now that no release still reads it (all
reads switched in N+3, and N+3 is the previous release during this
deploy's overlap).

15. **[Release N+4]** Remove `full_name` from all write paths — stop populating it on create/update. Continue writing `first_name`/`last_name` only.
16. **[Release N+4]** Do **not** drop or alter the `full_name` column in the schema yet — it must remain present (even if stale/frozen) so that Release N+3, still running during the overlap window, doesn't error on missing column/field mapping.
17. **[Release N+4]** Deploy and verify: confirm no new writes update `full_name`, and confirm Release N+3 (previous release) continues operating normally against the now-frozen `full_name` values it still reads (values will be stale going forward, but this is expected and short-lived, ending once N+3 traffic fully drains).

---

## Release N+5: Contract — drop the old column

Goal: remove `full_name` from the schema entirely, now that no running
release (N+4, the immediate predecessor) reads or writes it.

18. **[Release N+5]** Confirm via deploy/monitoring that Release N+4 is the only prior version that could still be live, and that it neither reads nor writes `full_name` (validated in step 17).
19. **[Release N+5]** Remove all remaining references to `full_name` from application code/models (should already be none after step 15, this is a final cleanup pass).
20. **[Release N+5]** Add migration: `ALTER TABLE users DROP COLUMN full_name;`
21. **[Release N+5]** Deploy and verify: confirm application runs correctly with `full_name` fully removed from schema and code, and that Release N+4 (previous release) has fully drained from traffic before or immediately as this migration runs (drop should be sequenced after old instances are confirmed terminated, per standard rolling-deploy safety practice for destructive schema changes).

---

## Rollback

General principle: because each release only ever *adds* capability or
*removes* a dependency that the immediately preceding release no longer
needs, rolling back one release at a time is always safe as long as the
schema from the *rolled-back-to* release's perspective is still present.
Never roll back past a step that dropped a column still required by the
target rollback version.

- **Rollback from N+5 (drop column) → N+4:**
  Re-add the column before rolling back code:
  `ALTER TABLE users ADD COLUMN full_name VARCHAR(255) NULL;`
  then re-run the backfill logic from step 9 (derive `full_name` from
  `first_name`/`last_name`) before resuming traffic on N+4, since N+4 does
  not write `full_name` but doesn't strictly need it either — safe to
  roll back to N+4 even with `full_name` empty, but backfilling avoids
  surprises if further rollback is needed.

- **Rollback from N+4 → N+3:**
  Safe immediately. `full_name` column still exists (never dropped in N+4).
  N+3 still reads/writes `full_name`; since N+4 stopped writing it, any
  rows written only during N+4's window will have stale `full_name`.
  Run a targeted backfill (reuse step 9 logic in reverse: derive
  `full_name` from `first_name`+`last_name`) for rows updated during the
  N+4 window before fully resuming N+3 traffic.

- **Rollback from N+3 → N+2:**
  Safe immediately. N+2 reads `full_name`, which is still being
  dual-written throughout N+3 (step 13), so no data gap exists. No backfill
  needed.

- **Rollback from N+2 → N+1:**
  Safe immediately. N+2 introduced no code changes, only a backfill job;
  simply stop/ignore the backfill job. No data loss — dual-write from N+1
  is untouched.

- **Rollback from N+1 → N:**
  Safe immediately. Reads never depended on `first_name`/`last_name`.
  Rolling back just stops dual-writing the new columns; existing rows keep
  whatever partial backfill occurred, which is harmless since nothing reads
  them yet.

- **Rollback from N → N-1:**
  Safe immediately. `first_name`/`last_name` columns are nullable and
  unused by any read/write logic in N-1; can optionally drop them or leave
  them in place (leaving them is simplest and non-breaking).

### Rollback safety checklist (apply before any rollback)
- Confirm which columns the rollback *target* release reads and writes.
- Confirm those columns still exist in the schema (re-add if a later
  release dropped them).
- Confirm those columns are current for rows written during the window
  between the target release and the release being rolled back from
  (backfill if a gap is possible).
- Never execute a rollback that lands on a release expecting a column that
  has been dropped without first restoring and repopulating that column.
