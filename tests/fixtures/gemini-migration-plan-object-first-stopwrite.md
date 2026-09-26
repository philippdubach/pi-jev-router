# Zero-Downtime Migration Plan: Split `users.full_name` into `first_name` and `last_name`

## 1. Executive Summary & Architecture Strategy

This document outlines the zero-downtime database and application migration plan to split the `users.full_name` column into separate `first_name` and `last_name` columns.

### Hard Constraint: Overlapping Releases (Blue-Green / Rolling Deployments)
At every deployment stage, **two consecutive releases run concurrently side-by-side** while traffic shifts from the old release to the new release. Therefore:
- The database schema must remain **backward-compatible** with the previous release and **forward-compatible** with the incoming release at all times.
- Application instances of Release $N$ and Release $N-1$ must be able to read and write concurrently without data corruption, missing fields, or runtime exceptions.
- No column may be dropped or made mandatory until **100% of all running application instances** have completely stopped referencing it.

### High-Level Release Matrix

| Release | Application Read Path | Application Write Path | Database Schema State | Side-by-Side Coexistence Compatibility |
| :--- | :--- | :--- | :--- | :--- |
| **Release 0** (Baseline) | `full_name` | `full_name` | `full_name` (NOT NULL) | Baseline production state. |
| **Release 1** (Expand & Dual-Write) | `full_name` | `full_name` **AND** (`first_name`, `last_name`) | `full_name`, `first_name` (NULL), `last_name` (NULL) | **R0 + R1**: R0 ignores new columns (nullable); R1 writes both old and new. Both read `full_name`. |
| *Out-of-band* | *N/A (Backfill Job)* | *N/A (Backfill Job)* | *Same as R1* | All live writes populate new columns; backfill fills historical NULL rows. |
| **Release 2** (Switch Reads) | `first_name`, `last_name` (fallback: `full_name`) | `full_name` **AND** (`first_name`, `last_name`) | *Same as R1* | **R1 + R2**: Both write to both old and new. R1 reads old; R2 reads new. Data stays 100% in sync. |
| **Release 3** (Stop Writing Old) | `first_name`, `last_name` | `first_name`, `last_name` (stops writing `full_name`) | `full_name` (deprecated), `first_name`, `last_name` | **R2 + R3**: Both read new columns. R3 stops updating `full_name`, which R2 never reads. |
| **Release 4** (Contract Schema) | `first_name`, `last_name` | `first_name`, `last_name` | `first_name` (NOT NULL), `last_name` (NOT NULL), `full_name` dropped | **R3 + R4**: Neither R3 nor R4 references `full_name`. Column drop is non-breaking. |

---

## 2. Name Parsing & Data Integrity Rules

To prevent diverging data representations, the application dual-write logic and the asynchronous backfill worker must use the **exact same canonical name-splitting logic**:

1. **Whitespace Normalization:** Trim leading, trailing, and duplicate inner whitespace (`"  Jane   Doe  "` $\rightarrow$ `"Jane Doe"`).
2. **Two-part Names:** Split on the first whitespace boundary (`"John Doe"` $\rightarrow$ `first_name = "John"`, `last_name = "Doe"`).
3. **Multi-part Names:** First whitespace boundary separates first name from surname/remaining tokens (`"Martin Luther King Jr."` $\rightarrow$ `first_name = "Martin"`, `last_name = "Luther King Jr."` or domain-specific standard).
4. **Single-token Names:** When no space exists (e.g. `"Cher"`, `"Madonna"`), set `first_name = "Cher"`, `last_name = ""` (empty string) to prevent NULL violations when constraints are enforced.
5. **Empty / Null Safety:** Empty strings in `full_name` default to empty strings for both `first_name` and `last_name`.
6. **Reverse Combination (for Dual-Write updates):** When updates occur via new endpoints (`first_name`, `last_name`), `full_name` is generated as `TRIM(CONCAT(first_name, ' ', last_name))`.

---

## 3. Step-by-Step Migration Plan Grouped by Release

Each step is assigned an absolute sequence number and clearly tagged with its owning release.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 MIGRATION TIMELINE                                     │
├───────────────┬────────────────────────────┬───────────────────────────┬───────────────┤
│   RELEASE 1   │   OUT-OF-BAND (POST-R1)    │         RELEASE 2         │   RELEASE 3   │
│ Expand Schema │  Backfill & Verification   │       Switch Reads        │  Stop Writes  │
│  Dual-Write   │                            │ (Maintain Dual-Write)     │  (Contract)   │
└───────┬───────┴─────────────┬──────────────┴─────────────┬─────────────┴───────┬───────┘
        │                     │                            │                     │
        ▼                     ▼                            ▼                     ▼
   Steps 1 - 3           Steps 4 - 5                  Steps 6 - 8           Steps 9 - 11
                                                                                 │
                                                                                 ▼
                                                                            RELEASE 4
                                                                          Drop Column
                                                                         Steps 12 - 14
```

---

### Release 1: Expand Schema & Enable Dual-Writing

#### Release Goal
Add new nullable columns to the database without table locks, deploy application dual-writing so all new mutations populate both old and new columns, while continuing to read from `full_name`.

#### Side-by-Side Coexistence Analysis (Release 0 & Release 1)
- **Database:** `first_name` and `last_name` are `NULL`.
- **Release 0 instances:** Do not know about the new columns. All `INSERT` and `UPDATE` statements omit them, leaving them `NULL`. All `SELECT` queries only query `full_name`.
- **Release 1 instances:** Dual-write to `full_name`, `first_name`, and `last_name`. They still read from `full_name`.
- **Interoperability:** If Release 0 writes a row, Release 1 can read it via `full_name`. If Release 1 writes a row, Release 0 can read it via `full_name`. No errors occur on either release.

---

#### Step 1: Add New Columns as Nullable (Release 1 — Pre-Deploy DB Migration)
Run the migration script to add `first_name` and `last_name` without table locks or defaults.

```sql
-- Step 1 (Release 1): Add new columns allowing NULL
-- Using standard non-blocking DDL
ALTER TABLE users 
    ADD COLUMN first_name VARCHAR(255) NULL,
    ADD COLUMN last_name VARCHAR(255) NULL;
```

*Validation:*
- Confirm columns exist:
  ```sql
  SELECT column_name, is_nullable, data_type 
  FROM information_schema.columns 
  WHERE table_name = 'users' AND column_name IN ('first_name', 'last_name');
  ```
- Verify existing Release 0 application instances continue processing transactions without error.

---

#### Step 2: Deploy Application Code with Dual-Writing (Release 1 — Rolling App Deploy)
Deploy the new application version configured as follows:
- **Read Path:** Read exclusively from `users.full_name`.
- **Write Path (INSERT):** Split input name into `first_name` and `last_name`; write to `full_name`, `first_name`, and `last_name`.
- **Write Path (UPDATE):**
  - If `full_name` is updated, recalculate and write `first_name`, `last_name`, and `full_name`.
  - If individual name fields are updated via any new API parameters, recalculate `full_name` and write all three columns.

*Application Logic Example:*
```typescript
// Release 1 Model / Repository
async function createUser(input: { fullName: string }) {
  const { firstName, lastName } = parseFullName(input.fullName);
  return db.query(
    `INSERT INTO users (full_name, first_name, last_name, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *`,
    [input.fullName, firstName, lastName]
  );
}

async function getUser(id: string) {
  // Read remains on old column
  const user = await db.query(`SELECT id, full_name FROM users WHERE id = $1`, [id]);
  return user;
}
```

---

#### Step 3: Decommission Release 0 (Release 1 — Post-Deploy)
- Monitor rolling deployment until **100% of running instances are Release 1**.
- Confirm zero active instances of Release 0 remain in service.
- *Milestone achieved:* Every incoming production write now populates `first_name` and `last_name`.

---

### Out-of-Band (Post-Release 1): Backfill Historical Data

#### Phase Goal
Backfill all historical rows where `first_name` or `last_name` is `NULL` without blocking live queries, causing replication lag, or holding long-lived locks.

*Prerequisite:* Step 3 must be complete (Release 0 completely decommissioned). This guarantees no new writes bypass dual-writing.

---

#### Step 4: Execute Batched, Throttled Asynchronous Backfill
Run a background worker script that paginates by primary key using keyset pagination (never `OFFSET`):

```sql
-- Keyset pagination query pattern run by the backfill worker
SELECT id, full_name 
FROM users 
WHERE (first_name IS NULL OR last_name IS NULL)
  AND id > :last_processed_id
ORDER BY id ASC 
LIMIT 500;
```

For each batch, the worker splits `full_name` using the canonical name parser and updates rows individually or via batch `UPDATE`:

```sql
UPDATE users AS u
SET 
    first_name = batch.first_name,
    last_name = batch.last_name
FROM (VALUES 
    (101, 'Ada', 'Lovelace'),
    (102, 'Alan', 'Turing')
) AS batch(id, first_name, last_name)
WHERE u.id = batch.id
  AND (u.first_name IS NULL OR u.last_name IS NULL); 
  -- Guard prevents overwriting a concurrent live user update
```

*Operational Controls:*
- Batch size: 500–1000 rows.
- Throttle: 50–100 ms sleep between batches to allow database vacuuming and replication catch-up.
- Run continuously until 0 rows remain unprocessed.

---

#### Step 5: Verify Backfill Completion and Parity (Pre-Release 2 Gate)
Execute integrity verification queries before approving Release 2 deployment:

```sql
-- 1. Ensure zero NULL records remain
SELECT COUNT(*) AS unmigrated_count 
FROM users 
WHERE first_name IS NULL OR last_name IS NULL;
-- MUST RETURN: 0

-- 2. Verify parity between reconstructed full_name and existing full_name
SELECT COUNT(*) AS mismatch_count
FROM users
WHERE TRIM(full_name) != TRIM(CONCAT(first_name, ' ', last_name))
  AND last_name != '' -- Single-word name exceptions
  AND full_name IS NOT NULL;
-- MUST RETURN: 0 (or match audited edge-case exemptions)
```

---

### Release 2: Switch Reads to New Columns

#### Release Goal
Switch all application read paths to use `first_name` and `last_name`. Keep dual-writing to both old and new columns so that Release 1 instances running side-by-side continue to see up-to-date data.

#### Side-by-Side Coexistence Analysis (Release 1 & Release 2)
- **Release 1 instances:** Read from `full_name`. Write to `full_name`, `first_name`, and `last_name`.
- **Release 2 instances:** Read from `first_name` and `last_name`. Write to `full_name`, `first_name`, and `last_name`.
- **Interoperability:**
  - When Release 1 writes: It writes both old and new columns. Release 2 reads new columns $\rightarrow$ sees the latest data.
  - When Release 2 writes: It writes both old and new columns. Release 1 reads old column $\rightarrow$ sees the latest data.
  - Zero read anomalies occur regardless of which release handles a given user request.

---

#### Step 6: Deploy Application Code with Read Path Switched (Release 2 — Rolling App Deploy)
Deploy application code updated as follows:
- **Read Path:** Read directly from `first_name` and `last_name`. Include a defensive inline fallback to `parseFullName(full_name)` in the rare event a column is empty:
  ```typescript
  // Release 2 Model / Repository
  async function getUser(id: string) {
    const user = await db.query(
      `SELECT id, first_name, last_name, full_name FROM users WHERE id = $1`,
      [id]
    );
    if (!user) return null;
    
    // Primary: new columns. Defensive fallback: parse full_name
    const firstName = user.first_name ?? parseFullName(user.full_name).firstName;
    const lastName = user.last_name ?? parseFullName(user.full_name).lastName;
    
    return {
      id: user.id,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`.trim()
    };
  }
  ```
- **Write Path (STILL DUAL-WRITING):** Continue writing to `full_name`, `first_name`, and `last_name` on all inserts and updates.

---

#### Step 7: Decommission Release 1 (Release 2 — Post-Deploy)
- Monitor the rolling deployment until 100% of active pods/instances are on Release 2.
- Decommission all Release 1 instances.
- *Milestone achieved:* No active instance in the cluster reads from `full_name` as its primary source.

---

#### Step 8: Telemetry & Parity Bake Period (Release 2 — Post-Deploy Gate)
- Monitor application logs, user profile pages, email generators, and downstream services for 24 hours.
- Verify read latency and confirm zero errors related to name formatting or empty values.

---

### Release 3: Contract Application — Stop Writing Old Column

#### Release Goal
Remove all write operations to `users.full_name`. The application now reads and writes exclusively to `first_name` and `last_name`.

#### Side-by-Side Coexistence Analysis (Release 2 & Release 3)
- **Release 2 instances:** Read from `first_name`/`last_name`. Write to both old and new.
- **Release 3 instances:** Read from `first_name`/`last_name`. Write ONLY to `first_name`/`last_name`.
- **Interoperability:**
  - Release 2 instances are already reading from `first_name` and `last_name`.
  - When Release 3 writes a row, it only populates `first_name` and `last_name`. Release 2 reads `first_name` and `last_name`, so Release 2 sees the fresh data!
  - Release 2 does NOT read `full_name`, so `full_name` being stale or NULL for rows updated by Release 3 has zero impact on Release 2 instances.

---

#### Step 9: Deploy Application Code with Old Writes Removed (Release 3 — Rolling App Deploy)
Deploy application code with `full_name` completely excised from data access layers and ORMs:
- **Read Path:** Exclusively `first_name` and `last_name`.
- **Write Path:** Exclusively `first_name` and `last_name`.
- **ORM Configuration:** Mark `full_name` as ignored/excluded to prevent ORMs (e.g. ActiveRecord, Django, Prisma, Hibernate) from selecting `*` or generating queries referencing `full_name`.

*Application Logic Example:*
```typescript
// Release 3 Model / Repository
async function createUser(input: { firstName: string; lastName: string }) {
  // full_name is completely omitted from the INSERT query
  return db.query(
    `INSERT INTO users (first_name, last_name, created_at, updated_at)
     VALUES ($1, $2, NOW(), NOW()) RETURNING id, first_name, last_name`,
    [input.firstName, input.lastName]
  );
}

async function getUser(id: string) {
  // full_name is completely omitted from the SELECT query
  return db.query(
    `SELECT id, first_name, last_name FROM users WHERE id = $1`,
    [id]
  );
}
```

---

#### Step 10: Decommission Release 2 (Release 3 — Post-Deploy)
- Complete rolling deployment until 100% of running application instances are on Release 3.
- Decommission all Release 2 instances.
- *Milestone achieved:* No running code in production reads or writes `full_name`.

---

#### Step 11: Production Soak Period (Release 3 — Pre-DDL Gate)
- Allow Release 3 to run in production for a designated bake period (e.g., 24–48 hours).
- Query database query logs to verify zero incoming queries reference `full_name`:
  ```sql
  -- Postgres pg_stat_statements check
  SELECT query, calls 
  FROM pg_stat_statements 
  WHERE query ILIKE '%full_name%' AND query ILIKE '%users%'
    AND last_exec > NOW() - INTERVAL '1 day';
  ```

---

### Release 4: Contract Schema — Enforce Constraints & Drop Old Column

#### Release Goal
Harden the new schema by enforcing `NOT NULL` constraints (using safe, lock-free mechanisms) and safely drop the deprecated `users.full_name` column.

#### Side-by-Side Coexistence Analysis (Release 3 & Release 4)
- **Release 3 instances:** Do not query or reference `full_name`. Write valid `first_name` and `last_name`.
- **Release 4 instances:** Database DDL execution and any updated database configuration.
- **Interoperability:** Because Release 3 does not reference `full_name` in any query, dropping `full_name` in the database does not cause SQL errors or schema mismatch crashes on running Release 3 instances.

---

#### Step 12: Add NOT NULL Constraints Safely (Release 4 — Pre-Deploy DB Migration)
Enforce constraints without table locks. In PostgreSQL, use `NOT VALID` followed by `VALIDATE CONSTRAINT` to avoid holding an exclusive lock on the entire table:

```sql
-- Step 12a: Add constraints without validating historical data immediately (instant)
ALTER TABLE users 
    ADD CONSTRAINT users_first_name_not_null CHECK (first_name IS NOT NULL) NOT VALID,
    ADD CONSTRAINT users_last_name_not_null CHECK (last_name IS NOT NULL) NOT VALID;

-- Step 12b: Validate constraints in background (scans table with SHARE UPDATE EXCLUSIVE lock; live writes unblocked)
ALTER TABLE users VALIDATE CONSTRAINT users_first_name_not_null;
ALTER TABLE users VALIDATE CONSTRAINT users_last_name_not_null;

-- (Optional: Convert to native NOT NULL once validated, supported lock-free in PostgreSQL 12+)
ALTER TABLE users 
    ALTER COLUMN first_name SET NOT NULL,
    ALTER COLUMN last_name SET NOT NULL;
```

---

#### Step 13: Drop the Old `full_name` Column (Release 4 — DB Migration)
Drop the column from the database:

```sql
-- Step 13: Drop deprecated column
ALTER TABLE users DROP COLUMN full_name;
```

*(Optional Intermediate Defense: If using PostgreSQL, rename to `full_name_deprecated_drop_pending` for 24 hours prior to dropping, or drop in a maintenance window).*

---

#### Step 14: Final System Verification & Cleanup (Release 4 — Post-Deploy)
1. Verify database schema:
   ```sql
   SELECT column_name, is_nullable, data_type 
   FROM information_schema.columns 
   WHERE table_name = 'users';
   ```
   Confirm `first_name` and `last_name` are present and `NOT NULL`; confirm `full_name` does not exist.
2. Confirm zero application errors across all services.
3. Remove any temporary backfill scripts and migration feature flags from the code repository.

---

## 4. Comprehensive Rollback Plan

Because every step is non-breaking and forward/backward compatible, rollback procedures differ depending on which phase the deployment is currently in.

```
ROLLBACK DECISION TREE:
=======================
Failure during Release 1 Deploy? ───► Roll back app to Release 0. Drop nullable columns if desired.
Failure during Backfill?         ───► Stop backfill script. Zero impact on live traffic (app still reads old).
Failure during Release 2 Deploy? ───► Roll back app to Release 1. Zero data loss (R2 dual-wrote to full_name).
Failure during Release 3 Deploy? ───► Roll back app to Release 2.
Failure after Release 4 DDL?     ───► Restore full_name column from first_name + last_name reconstruction.
```

---

### Rollback During Release 1 Deployment
- **Symptom:** Release 1 dual-write code triggers exceptions or performance degradation.
- **State:** Schema has nullable `first_name` and `last_name`. Release 0 and Release 1 are running side-by-side.
- **Rollback Procedure:**
  1. Roll back the rolling deployment to **Release 0**.
  2. Release 0 instances ignore `first_name` and `last_name`, writing only `full_name`.
  3. (Optional) Run DDL to drop unused columns:
     ```sql
     ALTER TABLE users DROP COLUMN IF EXISTS first_name, DROP COLUMN IF EXISTS last_name;
     ```
- **Data Loss:** Zero. All writes by both Release 0 and Release 1 populated `full_name`.

---

### Rollback During Backfill Execution (Post-Release 1)
- **Symptom:** Backfill script creates database load, lock contention, or replication delay.
- **State:** Release 1 is 100% deployed. Live traffic is dual-written. Backfill is partially complete.
- **Rollback Procedure:**
  1. Terminate the backfill worker process immediately.
  2. Live traffic is unaffected because all active instances (Release 1) still read from `full_name`.
  3. Tune backfill chunk size, add throttling sleeps, or reschedule during lower-traffic windows.
- **Data Loss:** Zero. Live writes continue dual-writing.

---

### Rollback During Release 2 Deployment
- **Symptom:** Release 2 read logic fails, displays corrupted names, or throws errors on specific user profiles.
- **State:** Release 1 and Release 2 are running side-by-side. Release 1 reads `full_name`; Release 2 reads `first_name`/`last_name`. **Crucially, both releases are still dual-writing to all three columns.**
- **Rollback Procedure:**
  1. Roll back the deployment to **Release 1**.
  2. Incoming traffic shifts back to Release 1 instances, which read from `full_name`.
- **Why this works seamlessly:** Because Release 2 continued to dual-write to `full_name` for every single insert and update, **`full_name` is 100% up-to-date**. No synchronization or reverse backfill is required.
- **Data Loss:** Zero.

---

### Rollback During Release 3 Deployment
- **Symptom:** Release 3 fails during deployment.
- **State:** Release 2 and Release 3 are running side-by-side. Release 3 has stopped writing to `full_name`.
- **Rollback Procedure:**
  1. Roll back the deployment to **Release 2**.
  2. Release 2 reads from `first_name` and `last_name`, and writes to all three columns.
  3. **Address Stale `full_name` Rows:** For the small window where Release 3 was running, rows updated or inserted by Release 3 will have missing or stale `full_name` values. Run a quick catch-up synchronization:
     ```sql
     -- Re-sync full_name for any rows touched during the failed Release 3 deployment
     UPDATE users 
     SET full_name = TRIM(CONCAT(first_name, ' ', last_name))
     WHERE full_name IS NULL 
        OR full_name != TRIM(CONCAT(first_name, ' ', last_name));
     ```
  4. Release 2 reads from `first_name` and `last_name`, so users do not observe data discrepancies even while this script executes.
- **Data Loss:** Zero.

---

### Rollback After Release 4 (Schema Contraction / Drop Column)
- **Symptom:** An external legacy service, analytics pipeline, or forgotten reporting query breaks because `full_name` was dropped.
- **State:** `users.full_name` has been dropped from the database.
- **Point of No Return Considerations:**
  Once a column is dropped via DDL, it cannot be undone with `ROLLBACK`. However, because `first_name` and `last_name` contain all underlying data, `full_name` can be reconstructed losslessly without restoring from backup.
- **Disaster Recovery Procedure:**
  1. Re-add `full_name` as a nullable column:
     ```sql
     ALTER TABLE users ADD COLUMN full_name VARCHAR(255) NULL;
     ```
  2. Populate `full_name` from the active columns:
     ```sql
     UPDATE users 
     SET full_name = TRIM(CONCAT(first_name, ' ', last_name))
     WHERE full_name IS NULL;
     ```
  3. If necessary, re-deploy Release 2 to resume dual-writing.
- **Data Loss:** Zero (lossless reconstruction).

---

## 5. Summary Checklist by Release

- [ ] **Release 1 (Expand & Dual-Write)**
  - [ ] Run Step 1: Add `first_name` and `last_name` as nullable.
  - [ ] Deploy Step 2: Release 1 app (writes `full_name`, `first_name`, `last_name`; reads `full_name`).
  - [ ] Complete Step 3: Decommission all Release 0 instances.
- [ ] **Post-Release 1 Backfill**
  - [ ] Run Step 4: Execute batched, throttled backfill script.
  - [ ] Run Step 5: Verify 0 rows with NULL `first_name` or `last_name` and 100% parity.
- [ ] **Release 2 (Switch Reads)**
  - [ ] Deploy Step 6: Release 2 app (reads `first_name`/`last_name`; continues dual-writing).
  - [ ] Complete Step 7: Decommission all Release 1 instances.
  - [ ] Complete Step 8: Observe 24-hour bake period.
- [ ] **Release 3 (Stop Writing Old)**
  - [ ] Deploy Step 9: Release 3 app (reads & writes ONLY `first_name`/`last_name`; omits `full_name`).
  - [ ] Complete Step 10: Decommission all Release 2 instances.
  - [ ] Complete Step 11: Observe 24-48 hour soak period with zero queries on `full_name`.
- [ ] **Release 4 (Contract Schema)**
  - [ ] Run Step 12: Add NOT NULL / CHECK constraints via safe validation pattern.
  - [ ] Run Step 13: Drop column `full_name`.
  - [ ] Run Step 14: Final validation and cleanup.
