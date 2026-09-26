# Migration Plan: Split `users.full_name` into `first_name` / `last_name`

## Ground rule

At every point during a deploy, **two releases run side by side** (the outgoing
release still serving in-flight traffic while the new one rolls out). Every
step below is written so that the *previous* release's read/write behavior
continues to work unmodified while the *new* release's behavior is active on
other instances. This is the classic **expand → migrate → contract** pattern,
split into 6 releases (R1–R6), each independently deployable and each safe to
run concurrently with the release immediately before it.

No two adjacent releases may ever assume the other has already happened. The
only exception is R6 (the DROP), which requires a soak period after R5 to be
safe — see notes.

---

## Release 1 — Expand schema (additive, no behavior change)

**Step 1.** (Release 1) Write and apply a DB migration that adds two new
nullable columns to `users`: `first_name` and `last_name`. No default value,
no `NOT NULL`, no backfill.

**Step 2.** (Release 1) Deploy. No application code reads or writes these
columns yet. Because the columns are nullable and unreferenced, the previous
release (pre-R1, which has no knowledge of them) keeps working exactly as
before, side by side with R1 instances. This release is purely additive and
carries no behavioral risk.

---

## Release 2 — Dual-write

**Step 3.** (Release 2) Add a shared `splitFullName(fullName)` helper used
consistently by the app and by the backfill job in Release 3, so both produce
identical results.

**Step 4.** (Release 2) Update every write path (`INSERT`/`UPDATE`) that sets
`full_name` so it *also* computes and writes `first_name`/`last_name` in the
same statement/transaction. Reads are untouched — still `full_name` only.

**Step 5.** (Release 2) Deploy. During rollout, R1 instances write only
`full_name` (fine — new columns simply stay `NULL` on those rows), and R2
instances write both. Since nothing reads the new columns yet, having some
rows with `NULL` first/last name at this point is expected and harmless.

---

## Release 3 — Backfill existing rows

**Step 6.** (Release 3) Run an idempotent, batched, rate-limited backfill
job that sets `first_name`/`last_name` for all rows where they are `NULL`
and `full_name IS NOT NULL`, using the exact same `splitFullName` logic as
the app. Batch by primary key range, throttle to protect replicas, and make
it safely re-runnable (`WHERE first_name IS NULL`).

**Step 7.** (Release 3) This is a data job, not a code deploy — it is safe to
run while R1 and/or R2 instances are still serving traffic, because it only
ever fills in `NULL`s and never conflicts with the dual-write path (both use
the same split logic, so re-writes are idempotent).

**Step 8.** (Release 3) Verify completeness:
`SELECT count(*) FROM users WHERE full_name IS NOT NULL AND (first_name IS NULL OR last_name IS NULL)`
must be `0`. Re-run the job to catch stragglers created during the backfill
window (rows inserted by lagging R1 instances that haven't been dual-written
yet).

---

## Release 4 — Enforce integrity and switch reads

**Step 9.** (Release 4) Apply constraints now that data is fully backfilled
and all live write paths dual-write: add `NOT NULL` on `first_name`/`last_name`
(e.g. in Postgres, add as `CHECK (...) NOT VALID` then `VALIDATE CONSTRAINT`
to avoid a long table lock). This does not affect old-release writes because
R2/R3 releases already populate both columns on every write.

**Step 10.** (Release 4) Update all read paths to read from
`first_name`/`last_name` instead of `full_name`. For any consumer/API that
still expects a single `full_name` field, compute it on the fly at the
serialization layer (`first_name || ' ' || last_name`) rather than reading
the column, so the external contract is unaffected.

**Step 11.** (Release 4) (Recommended) Gate the read switch behind a feature
flag so it can be disabled instantly without a redeploy if something looks
wrong.

**Step 12.** (Release 4) Deploy. R3 instances (still reading `full_name`,
still dual-writing) and R4 instances (reading new columns, still
dual-writing) coexist safely — both columns are guaranteed populated on every
row by this point, so either read path returns correct data.

---

## Release 5 — Stop writing the old column

**Step 13.** (Release 5) Remove `full_name` from all write paths; only write
`first_name`/`last_name` going forward. Do **not** drop the column yet.

**Step 14.** (Release 5) Keep the on-the-fly `full_name` computation in the
read/serialization layer for any external consumers (already done in R4), so
nothing downstream notices `full_name` has stopped being updated.

**Step 15.** (Release 5) Deploy. R4 instances (still writing `full_name` +
reading new columns) and R5 instances (no longer writing `full_name`)
coexist safely: R5 instances simply don't refresh a column nothing reads
anymore. `full_name` becomes stale/frozen for rows touched only by R5, which
is fine since it is not read by any release from R4 onward.

---

## Release 6 — Contract: drop the old column

**Step 16.** (Release 6, only after a soak period — see note below) Audit
all code paths, background jobs, ETL/BI queries, reporting pipelines, and
any other service that might still reference `users.full_name` directly in
the database (not just the app's ORM). Confirm zero references.

**Step 17.** (Release 6) Take a lightweight safety snapshot before dropping:
either rely on point-in-time DB backups, or copy `id, full_name` into a
`users_full_name_backup` table with a retention window, so recovery doesn't
require restoring the whole DB if the drop needs to be undone.

**Step 18.** (Release 6) Apply a DB migration that drops the `full_name`
column.

**Step 19.** (Release 6) Deploy the migration only once R5 has been running
standalone for a full deploy cycle (i.e., there is no rollback path that
would expect a previous release still relying on `full_name`). Recommended
soak: at least one full release cycle with monitoring/error-rate checks
before running this step.

---

## Rollback

Rollback is release-scoped: at any point, revert only to the immediately
prior release's code, and the DB schema/data from earlier steps remains
compatible because each release was designed to tolerate its predecessor.

- **Rollback from Release 1:** Simply stop the deploy / redeploy the prior
  code. The added columns are unused and nullable — harmless to leave in
  place. No data changes to undo.

- **Rollback from Release 2:** Redeploy Release 1 code (stop dual-write). Any
  rows already dual-written keep their `first_name`/`last_name` values
  (unused, harmless). No reads depend on them yet, so no data repair needed.

- **Rollback from Release 3 (backfill):** The backfill is a standalone job,
  not tied to a code release. If it causes load issues, pause/abort it —
  it's idempotent and safely resumable later. No application rollback
  required.

- **Rollback from Release 4:** Redeploy Release 3 code (reads revert to
  `full_name`; dual-write continues). If the `NOT NULL` constraint (Step 9)
  is itself the problem (e.g. an edge case in the split logic caused write
  failures), drop the constraint immediately as an emergency fix, independent
  of the code rollback. Use the feature flag (Step 11) for an instant,
  redeploy-free revert of the read switch if it was flagged.

- **Rollback from Release 5:** Redeploy Release 4 code so `full_name` starts
  being written again. Because R5 stopped updating `full_name`, rows
  modified only during the R5 window will have a *stale* `full_name`; run a
  short repair pass: `full_name = first_name || ' ' || last_name` for rows
  updated after the R5 rollout began, before relying on `full_name` again.

- **Rollback from Release 6 (dropped column):** This is the only
  non-trivial rollback. Recovery requires re-adding the column and
  repopulating it: `ALTER TABLE users ADD COLUMN full_name text;` followed by
  `UPDATE users SET full_name = first_name || ' ' || last_name`, or restoring
  values from the `users_full_name_backup` snapshot (Step 17) if you need the
  exact pre-split strings rather than a recomposed version. This is why R6 is
  gated on a soak period and a backup snapshot — treat the drop as
  effectively irreversible in the fast-rollback sense, and don't run it until
  confidence is high.
