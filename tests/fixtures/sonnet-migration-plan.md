# Migration Plan: Split `users.full_name` into `first_name` + `last_name`

## Constraints & Approach

- Deploys are rolling: for every deploy, release `N` (old code) and release `N+1`
  (new code) run **simultaneously** against the **same database** for some
  window of time.
- Therefore no single deploy may ship a schema change and a code change that
  depends on it at the same time. Every schema change must be backward
  compatible with the *previous* release's code, and every code change must
  be forward compatible with the *current* schema.
- This is the standard **expand → migrate → contract** pattern, split across
  five releases (R1–R5). Each release is a separate deploy; do not skip or
  merge steps across releases.

---

## Release R1 — Expand schema (additive only)

Goal: add new columns without touching any application code path. Old release
and this release both read/write only `full_name`, so it is always safe for
them to coexist.

1. Write and run a migration that adds two new nullable columns to `users`:
   `first_name VARCHAR NULL`, `last_name VARCHAR NULL`. No `NOT NULL`, no
   default, no unique/foreign key constraints, no application code changes in
   this release.
2. Deploy R1. At this point old release (pre-R1) and R1 are both running
   against a schema that has the new columns, but neither release references
   them — 100% safe overlap.
3. Verify migration applied cleanly in all environments (staging, then
   production) and confirm no code path errors reference the new columns.

---

## Release R2 — Dual-write (old column stays authoritative)

Goal: start populating `first_name`/`last_name` on every write, while
`full_name` remains the single source of truth for reads. Because R1 already
shipped the columns, R2 can safely write to them even while old-R1 replicas
are still serving traffic (they simply ignore the new columns).

4. Add a shared helper (e.g. `splitFullName(fullName)`) that deterministically
   derives `first_name`/`last_name` from `full_name` (e.g. split on first
   whitespace; document the edge-case rule for single-word names, multiple
   spaces, suffixes, etc.).
5. Update every write path (create user, update user, admin tools, import
   jobs, etc.) to write **both**: continue writing `full_name` as before, and
   additionally compute and write `first_name`/`last_name` via the helper in
   the same transaction/request.
6. All read paths continue to read only `full_name` — unchanged in this
   release.
7. Deploy R2. During the rollout window, R1 (writes `full_name` only) and R2
   (writes both) run side by side; both leave `full_name` fully correct, so
   reads by either release are unaffected. Rows written by R1 during this
   window simply have `first_name`/`last_name` left `NULL`, to be caught by
   backfill.
8. Verify in production that new/updated rows from R2 instances have
   `first_name`/`last_name` populated and consistent with `full_name`.

---

## Backfill (runs after R2 is fully rolled out, before R3 is deployed)

9. Confirm R2 is deployed to 100% of instances (no R1 instances remain), so
   every new write from this point on populates all three columns.
10. Run an idempotent, batched/throttled backfill job that selects rows where
    `first_name IS NULL OR last_name IS NULL` and populates them from
    `full_name` using the same `splitFullName` helper used in R2. Batch by
    primary key range, throttle to avoid replication lag/lock contention, and
    make it safely re-runnable/resumable.
11. Run a verification query confirming `first_name`/`last_name` are non-null
    (or intentionally blank per the documented edge-case rule) for 100% of
    rows, and spot-check a sample against `full_name` for correctness.

---

## Release R3 — Switch reads to new columns (old column still written)

Goal: start reading from `first_name`/`last_name`, while still writing
`full_name` so that a rollback to R2 (or R1) remains fully functional.

12. Update all read paths (API responses, templates/views, search/sort,
    exports, downstream consumers) to read from `first_name`/`last_name`
    (e.g. render `${first_name} ${last_name}` where `full_name` was
    previously used), instead of `full_name`.
13. Keep all write paths from R2 unchanged: continue writing `full_name` in
    addition to `first_name`/`last_name`.
14. Deploy R3. During rollout, R2 (reads `full_name`, writes all three) and
    R3 (reads new columns, writes all three) run side by side; both keep all
    three columns in sync, so either release's reads are correct regardless
    of which release produced the row.
15. Monitor for any consumers (internal tools, reports, other services) still
    depending on `full_name` directly; update them before proceeding — R3 is
    the last release where `full_name` is guaranteed fresh.

---

## Release R4 — Stop writing the old column

Goal: remove `full_name` from the write path. Reads no longer use it (that
happened in R3), so this is safe now.

16. Remove `full_name` from all write paths (create/update/import), writing
    only `first_name`/`last_name`.
17. Leave the `full_name` column in the schema (do not drop yet) and leave it
    nullable/unenforced so that R3 instances still running during the deploy
    window can continue to write it without error — R4 simply stops writing
    it, it doesn't forbid it.
18. Deploy R4. During rollout, R3 (writes all three) and R4 (writes only the
    new two) run side by side; both leave `first_name`/`last_name` correct,
    which is all that matters since nothing reads `full_name` anymore after
    R3.
19. Let R4 run in production for a full observation period (e.g. 1–2 weeks)
    to build confidence that no residual read/write dependency on
    `full_name` exists (grep code, check logs/errors, check
    analytics/reporting jobs, scheduled batch jobs, third-party
    integrations).

---

## Release R5 — Drop the old column (contract schema)

Goal: remove `full_name` from the schema now that no release reads or writes
it.

20. Confirm 100% of running instances are on R4 or later, and confirm no
    external system reads `full_name` directly from the database (e.g. BI
    tools, replicas, data warehouse ETL) — update or freeze those first.
21. Deploy R5 (code): remove any remaining references to `full_name` in code
    (models/ORM schema definitions, serializers, migration scripts, docs).
22. Run a migration that drops the `full_name` column from `users`.
    Optionally rename it to `full_name_deprecated` and drop it in a later,
    separate cleanup migration instead of dropping directly, to leave a
    cheap undo path.
23. Verify application health, error rates, and logs post-drop. Migration
    complete.

---

## Rollback Plan

General principle: because every step above is only additive/parallel-safe
for the *release it's paired with*, rollback is just "redeploy the previous
release," except where a schema change is irreversible (a drop). Roll back
one release at a time, in reverse order, verifying after each.

- **Roll back R5 → R4**: If `full_name` was dropped in step 22, it cannot be
  un-dropped from the DB alone.
  - Preferred: don't drop destructively — use the rename-then-drop-later
    approach from step 22, so rollback = redeploy R4 and restore the column
    from `full_name_deprecated` (rename back) if within the retention window.
  - If already hard-dropped: restore `full_name` via migration
    (`ADD COLUMN full_name`), then re-run the backfill logic (step 10, in
    reverse: derive `full_name` from `first_name`/`last_name`) before
    redeploying R4 code.
  - Mitigate risk up front by keeping R5 deploy small/isolated and only
    running it after the R4 observation period, plus taking a DB
    snapshot/backup immediately before step 22.

- **Roll back R4 → R3**: Pure code rollback. Redeploy R3. `full_name` is
  still present in the schema (R4 never dropped it, only stopped writing
  it), and R3 writes it again on every request. Rows written only during
  the R4 window will have a stale `full_name`; re-run the backfill job
  (step 10) to resync `full_name` from `first_name`/`last_name` for the
  affected window if needed.

- **Roll back R3 → R2**: Pure code rollback. Redeploy R2. `full_name` was
  never stopped being written (R3 still wrote it), so reads immediately
  become correct again with no data repair needed.

- **Roll back R2 → R1**: Pure code rollback. Redeploy R1. `first_name`/
  `last_name` simply stop being populated for new writes; no data is lost or
  corrupted since `full_name` was always authoritative. Re-run backfill
  (step 10) once R2 (or later) is redeployed to catch up any gap.

- **Roll back R1**: Dropping the (still-unused) `first_name`/`last_name`
  columns is safe at any time before R3 ships, since nothing reads them yet;
  only do this if abandoning the migration entirely.

- **General safeguards**: take a database backup/snapshot before each
  migration step (especially steps 1, 10, 22); make the backfill job
  idempotent and resumable so it can always be safely re-run after any
  rollback; keep each release's diff small and scoped to exactly the steps
  listed for that release so rollback boundaries stay clean.
