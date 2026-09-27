# Migration Plan: Split `users.full_name` into `first_name` and `last_name`

## Context & Constraints

- **Hard constraint:** Two releases run side by side during every deploy (rolling/blue-green). The previous release keeps serving traffic while the new release rolls out. Every schema and code change must therefore be safe for **both** the current release (N) and the previous release (N−1) at all times.
- **Consequences:**
  - Schema changes must be additive-only until no running release depends on the old shape. Never rename or drop a column in the same release that stops using it.
  - New columns must be nullable (or have defaults) so the old release's `INSERT`s — which know nothing about them — keep working.
  - The old column `full_name` must keep being written as long as any running release reads it, and must keep existing as long as any running release writes it.
  - Because the old release only writes `full_name` (never the new columns), the new release must derive new-column values from `full_name` whenever the new columns are missing (backfill-on-read / write path), and the backfill must be re-runnable.

## Overview

| Release | Schema | Writes | Reads |
|---|---|---|---|
| N (current) | `full_name` only | `full_name` | `full_name` |
| N+1 | + `first_name`, `last_name` (nullable) | `full_name` **and** new columns (dual-write) | `full_name` |
| N+2 | unchanged | dual-write | new columns (fallback to `full_name`) |
| N+3 | unchanged | new columns only | new columns |
| N+4 | drop `full_name` | new columns only | new columns |

---

## Release N+1 — Add columns, start dual-write, backfill

**Goal:** new columns exist and stay in sync, while release N (still running side by side) is completely unaffected.

1. **Schema migration (additive, online):** add `first_name TEXT NULL` and `last_name TEXT NULL` to `users`. No default, no `NOT NULL`, no index yet if the table is very large (use a concurrent/online index build in a later step if needed). Nullable is required: release N's inserts don't set these columns and must not fail.
2. **Deploy code that dual-writes:** every create/update path writes `full_name` exactly as before **and** writes `first_name`/`last_name` derived from it (same split logic as the backfill). Reads still use `full_name` only. During the N → N+1 rollout, release N instances keep writing `full_name` alone — safe, because nothing reads the new columns yet.
3. **Backfill existing rows:** run a batched, throttled, idempotent job:
   - `UPDATE users SET first_name = ..., last_name = ... WHERE id BETWEEN ? AND ? AND (first_name IS NULL AND last_name IS NULL)` (or a `full_name IS NOT NULL` guard), in small batches with keyset pagination.
   - Idempotent and re-runnable, because release N instances (still in rotation during N+1's deploy) may write rows with `full_name` set and new columns NULL at any time until release N is fully gone.
4. **Verify backfill:** row-count and NULL-count checks (`SELECT count(*) FROM users WHERE full_name IS NOT NULL AND first_name IS NULL`). Re-run the backfill until the count is zero and stays zero.
5. **Add a consistency guard (optional but recommended):** a DB trigger or a write-path normalization that populates `first_name`/`last_name` from `full_name` whenever they are NULL, so stragglers from the old release can't create permanently unsynced rows.

**Gate to proceed:** N+1 fully rolled out (no N instances left), backfill verified at 0 unsynced rows.

## Release N+2 — Switch reads to the new columns

**Goal:** reads move to `first_name`/`last_name`; writes unchanged so N+1 (still running side by side) keeps working.

6. **Deploy code that reads `first_name`/`last_name`** instead of `full_name`, with a fallback: if the new columns are NULL but `full_name` is set, split `full_name` on the fly (covers any row that slipped through). Writes are **unchanged** — still dual-write `full_name` + new columns. This is required because release N+1 (in rotation during this deploy) still reads `full_name`; if N+2 stopped writing it, N+1 would serve stale names.
7. **Monitor:** compare read results old-vs-new on a sample (shadow-read logging) and watch error rates. Alert on any row where the fallback path is hit, since that indicates an unsynced row.

**Gate to proceed:** N+2 fully rolled out, no fallback-path hits for an agreed soak period.

## Release N+3 — Stop writing the old column

**Goal:** `full_name` becomes dead weight; nothing writes it, nothing reads it.

8. **Deploy code that writes only `first_name`/`last_name`** and no longer sets `full_name` (writes NULL or omits it). Safe because:
   - The side-by-side release is N+2, which reads only the new columns.
   - No release since N+2 reads `full_name`, so leaving it stale is harmless.
   - `full_name` must still **exist** and be nullable (or omitted from inserts): release N+2's code still includes it in write statements, so dropping it now would break N+2.
9. **Remove the consistency guard/trigger** from step 5 if one was added, since dual-write is gone.
10. **Verify:** audit query confirms no code path reads or writes `full_name`; add a temporary log/alert on any access.

**Gate to proceed:** N+3 fully rolled out, zero observed accesses to `full_name` for a full deploy cycle plus soak.

## Release N+4 — Drop the old column

**Goal:** remove the dead column.

11. **Schema migration:** `ALTER TABLE users DROP COLUMN full_name`. Safe because the side-by-side release is N+3, which neither reads nor writes it. If `full_name` was `NOT NULL` historically, that constraint is irrelevant now — the column is dropped entirely.
12. **Post-drop verification:** run the full test suite, confirm no ORM models, admin tooling, reports, ETL, or downstream consumers reference `full_name` (codebase-wide search before this release ships).

---

## Rollback

Rollback is always "redeploy the previous release," but the safe window depends on which step you're in:

- **During/after step 1 (schema only):** rolling back code is always safe — the new columns are inert. Roll back the schema only if N+1 code was never deployed; otherwise leave the nullable columns in place (harmless) and drop them later.
- **During/after steps 2–5 (dual-write + backfill, reads still on `full_name`):** roll back to release N freely. `full_name` is still the source of truth and is fully maintained. New columns are ignorable; partial backfill is fine.
- **During/after steps 6–7 (reads on new columns, still dual-writing):** roll back to N+1. `full_name` is still being written by every release in rotation, so N+1's reads stay correct. **Do not roll back to N** — N doesn't dual-write, so any rows it touches would desync the new columns that N+1/N+2 now read. If an emergency N rollback is unavoidable, re-run the backfill (step 3) immediately afterward.
- **During/after steps 8–10 (writes stopped on `full_name`):** roll back to N+2 safely. **Do not roll back to N+1 or N** without first re-enabling dual-write and re-running the backfill — those releases read `full_name`, which is no longer being updated and is going stale.
- **After step 11 (`full_name` dropped):** no code rollback past N+3 is possible. To go back further you must first re-add `full_name` as nullable, re-enable dual-write (N+1-style code), and backfill `full_name` from `first_name`/`last_name` (note: this reverse mapping is lossy — e.g., multi-word first names — so treat it as a disaster-recovery path, not a routine rollback).

**General rules:**
1. Never roll back more than one release at a time.
2. Never roll back across a "stop writing" or "drop column" boundary without first restoring the write path and re-running the backfill.
3. Keep the backfill job and the `full_name` → split parsing logic in the repo until step 12 is verified complete.
