# Zero-Downtime Migration Plan: Split `users.full_name` into `first_name` and `last_name`

## Executive Summary & Architectural Constraints

This document defines the production migration plan to split the `users.full_name` column into `first_name` and `last_name`.

### Core Constraint: Side-by-Side Coexistence
In our deployment pipeline (blue-green / rolling deployments), **two consecutive releases run side-by-side during every deployment window**. At any point during a rollout:
- Instances running **Release $N$** and instances running **Release $N+1$** concurrently serve live user traffic against the same database.
- Any step, schema change, query, or write pattern must remain **backward-compatible** with the previous release and **forward-compatible** with the incoming release.
- A deployment can be aborted or rolled back at any point without data corruption, failed queries, or downtime.

To satisfy these constraints, we follow the **Expand and Contract (Parallel Run)** pattern executed over **four distinct releases**:

1. **Release 1 (Expand & Dual-Write)**: Add nullable new columns, start dual-writing to both old and new columns, and backfill historical rows.
2. **Release 2 (Switch Reads)**: Switch application reads to `first_name` and `last_name` while continuing to dual-write both old and new.
3. **Release 3 (Stop Writing Old Column)**: Cease writing to `full_name` and relax old constraints; all writes and reads now target only new columns.
4. **Release 4 (Contract & Cleanup)**: Drop the `full_name` column from the database and remove legacy compatibility code.

---

## Release Compatibility Matrix

| Release | Active Application Instances During Deploy | DB Schema State | App Reads From | App Writes To | Compatibility Guarantee During Overlap |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Baseline (R0)** | Release 0 only | `full_name NOT NULL` | `full_name` | `full_name` | N/A (Standard baseline) |
| **Release 1** | Release 0 & Release 1 | `full_name NOT NULL`<br>`first_name NULL`<br>`last_name NULL` | `full_name` | **R0**: `full_name`<br>**R1**: `full_name`, `first_name`, `last_name` | R0 ignores new nullable columns. R1 writes both, ensuring R0 reads fresh data. |
| **Release 2** | Release 1 & Release 2 | All columns populated and synchronized | **R1**: `full_name`<br>**R2**: `first_name`, `last_name` | **R1**: Both<br>**R2**: Both | Both versions dual-write. R1 reads `full_name`, R2 reads `first_name`/`last_name`. Neither sees stale data. |
| **Release 3** | Release 2 & Release 3 | `full_name NULL`<br>`first_name NOT NULL`<br>`last_name NOT NULL` | `first_name`, `last_name` | **R2**: Both<br>**R3**: `first_name`, `last_name` | R2 already reads only new columns. R3 stopping writes to `full_name` has zero impact on R2. |
| **Release 4** | Release 3 & Release 4 | `full_name` dropped | `first_name`, `last_name` | `first_name`, `last_name` | Neither R3 nor R4 references `full_name`. Dropping the column is completely safe. |

---

## Name Splitting Logic & Business Rules

To ensure deterministic data splitting during dual-writes and backfill, the following transformation rules apply:

1. **Standard Two-Token Names** (e.g., `"Jane Doe"`):
   - `first_name`: `"Jane"`
   - `last_name`: `"Doe"`
2. **Multi-Token Names** (e.g., `"Mary Jane Watson"` or `"Ludwig van Beethoven"`):
   - Standard convention: First whitespace-delimited token is `first_name` (`"Mary"` / `"Ludwig"`), remainder is `last_name` (`"Jane Watson"` / `"van Beethoven"`).
3. **Single-Token Names** (e.g., `"Cher"`, `"Plato"`):
   - `first_name`: `"Cher"`
   - `last_name`: `""` (empty string) to satisfy non-null requirements where applicable.
4. **Dual-Write Recombination Rule**:
   - `full_name = TRIM(CONCAT(first_name, ' ', last_name))`
   - Trims extraneous whitespace; preserves exact representation for legacy consumers.

---

## Numbered Sequence of Steps Grouped by Release

Every step belongs to an explicit release, numbered sequentially from Step 1 through Step 15.

```
+-------------------------------------------------------------------------------------------------+
|                                     MIGRATION LIFECYCLE                                         |
+-------------------------------------------------------------------------------------------------+
| Release 1: Expand & Dual-Write                                                                  |
|   Step 1: DB Migration (Add nullable first_name, last_name)                                     |
|   Step 2: Deploy App Release 1 (Dual-write; read full_name)                                     |
|   Step 3: Decommission Release 0 fleet                                                          |
|   Step 4: Asynchronous batched backfill of historical rows                                      |
|   Step 5: Verify data parity and backfill completeness                                          |
+-------------------------------------------------------------------------------------------------+
| Release 2: Switch Reads                                                                         |
|   Step 6: Deploy App Release 2 (Read first_name/last_name; keep dual-writing)                    |
|   Step 7: Decommission Release 1 fleet                                                          |
|   Step 8: Soak period and read performance verification                                         |
+-------------------------------------------------------------------------------------------------+
| Release 3: Stop Writing Old Column                                                              |
|   Step 9: DB Migration (Drop NOT NULL on full_name; add constraints to new columns)            |
|   Step 10: Deploy App Release 3 (Write only first_name/last_name; read only new)                |
|   Step 11: Decommission Release 2 fleet                                                         |
|   Step 12: Ignore full_name in application models/ORM schema cache                              |
+-------------------------------------------------------------------------------------------------+
| Release 4: Contract & Drop Old Column                                                           |
|   Step 13: DB Migration (DROP COLUMN full_name)                                                 |
|   Step 14: Deploy App Release 4 (Remove dead code, parsing logic, and migration flags)          |
|   Step 15: Run post-migration table maintenance (ANALYZE / VACUUM)                              |
+-------------------------------------------------------------------------------------------------+
```

---

### Release 1: Expand & Dual-Write

#### Step 1 (Release 1): Pre-deployment Database Migration — Add New Columns
- **Release Assignment**: Release 1 (Pre-deployment)
- **Action**: Add `first_name` and `last_name` columns to the `users` table as **nullable** fields without default values.
- **DDL Execution**:
  ```sql
  -- Set lock timeout to avoid blocking traffic
  SET lock_timeout = '3s';

  ALTER TABLE users
    ADD COLUMN first_name VARCHAR(255) NULL,
    ADD COLUMN last_name  VARCHAR(255) NULL;
  ```
- **Side-by-Side Coexistence Safety**:
  - Release 0 instances are currently running and issuing `INSERT INTO users (full_name, ...) VALUES (...)`.
  - Because `first_name` and `last_name` are **nullable**, Release 0 inserts and updates continue to succeed without errors or warnings.
  - Release 0 does not select these new columns, so its query plans and memory allocations remain unchanged.

#### Step 2 (Release 1): Deploy Application Release 1 — Enable Dual-Writing
- **Release Assignment**: Release 1 (Application Deployment)
- **Action**: Deploy application code configured as follows:
  - **Reads**: Still read from `full_name`. (Do NOT read from `first_name`/`last_name` yet, as historical records are not yet backfilled).
  - **Writes**: Dual-write to both `full_name` AND (`first_name`, `last_name`).
- **Application Logic Implementation**:
  ```python
  def create_or_update_user(user_data):
      # Parse or extract names
      if "first_name" in user_data and "last_name" in user_data:
          first_name = user_data["first_name"].strip()
          last_name = user_data["last_name"].strip()
          full_name = f"{first_name} {last_name}".strip()
      else:
          full_name = user_data["full_name"].strip()
          first_name, last_name = split_full_name(full_name)

      # Dual-write: write to BOTH old and new columns
      db.execute(
          """
          INSERT INTO users (id, full_name, first_name, last_name, updated_at)
          VALUES (:id, :full_name, :first_name, :last_name, NOW())
          ON CONFLICT (id) DO UPDATE SET
              full_name = EXCLUDED.full_name,
              first_name = EXCLUDED.first_name,
              last_name = EXCLUDED.last_name,
              updated_at = NOW()
          """,
          {"id": user_data["id"], "full_name": full_name, "first_name": first_name, "last_name": last_name}
      )
  ```
- **Side-by-Side Coexistence Safety**:
  - During the rollout, Release 0 and Release 1 run concurrently.
  - An insert/update handled by Release 0 writes only `full_name` (leaving `first_name`/`last_name` NULL). Both Release 0 and Release 1 read from `full_name`, so neither sees missing data.
  - An insert/update handled by Release 1 writes `full_name`, `first_name`, and `last_name`. Release 0 reads `full_name` and sees the accurate data. Release 1 also reads `full_name`.
  - No user-visible inconsistency or broken reads can occur.

#### Step 3 (Release 1): Decommission Release 0 Fleet
- **Release Assignment**: Release 1 (Post-deployment)
- **Action**: Complete the rollout and terminate all Release 0 instances. Verify through metrics and deployment logs that 100% of serving nodes are running Release 1.
- **Why this step is mandatory before Step 4**: If historical backfill were executed while Release 0 instances were still writing, a Release 0 write could touch a row right after the backfill script processed it, leaving `first_name` and `last_name` permanently out of sync. Once 100% of nodes are on Release 1, every live write automatically updates both old and new columns.

#### Step 4 (Release 1): Execute Asynchronous Historical Backfill
- **Release Assignment**: Release 1 (Post-deployment Background Task)
- **Action**: Run an out-of-band, throttled batch script to populate `first_name` and `last_name` for all legacy rows where `first_name IS NULL`.
- **Backfill Script Specifications**:
  - Uses cursor/keyset pagination based on primary key (`id`) to prevent table locks and query degradation.
  - Updates rows in chunks of 500–1,000 with a sleep interval (e.g., 50ms) to prevent replication lag and CPU spikes.
  - Idempotent: Can be stopped and resumed at any time.
- **Execution Script**:
  ```sql
  -- Iterative batch execution pseudo-code
  DO $$
  DECLARE
      batch_size INT := 1000;
      rows_updated INT;
  BEGIN
      LOOP
          WITH target_batch AS (
              SELECT id, full_name
              FROM users
              WHERE first_name IS NULL
              ORDER BY id
              LIMIT batch_size
              FOR UPDATE SKIP LOCKED
          )
          UPDATE users u
          SET
              first_name = SPLIT_PART(TRIM(tb.full_name), ' ', 1),
              last_name  = SUBSTRING(TRIM(tb.full_name) FROM LENGTH(SPLIT_PART(TRIM(tb.full_name), ' ', 1)) + 2)
          FROM target_batch tb
          WHERE u.id = tb.id;

          GET DIAGNOSTICS rows_updated = ROW_COUNT;
          EXIT WHEN rows_updated = 0;

          -- Sleep to allow replication stream to breathe
          PERFORM pg_sleep(0.05);
          COMMIT;
      END LOOP;
  END $$;
  ```
- **Side-by-Side Coexistence Safety**:
  - Live traffic is handled exclusively by Release 1 (dual-writing). If an active user modifies their profile during the backfill, Release 1 writes both columns with the latest data. The backfill uses `FOR UPDATE SKIP LOCKED` or checks `WHERE first_name IS NULL`, ensuring it never overwrites newer live writes with stale data.

#### Step 5 (Release 1): Verify Data Parity and Completeness
- **Release Assignment**: Release 1 (Validation Gate)
- **Action**: Run verification queries to ensure 100% of rows have valid `first_name` and `last_name` values before authorizing Release 2.
- **Verification Queries**:
  ```sql
  -- 1. Ensure zero unmigrated rows
  SELECT COUNT(*) AS unmigrated_count
  FROM users
  WHERE first_name IS NULL OR last_name IS NULL;
  -- Must return 0

  -- 2. Sample audit for consistency
  SELECT id, full_name, first_name, last_name
  FROM users
  WHERE TRIM(full_name) != TRIM(CONCAT(first_name, ' ', last_name))
    AND full_name != ''
  LIMIT 50;
  -- Must return 0 rows (allowing for single-name edge cases handled by policy)
  ```

---

### Release 2: Switch Reads

#### Step 6 (Release 2): Deploy Application Release 2 — Switch Reads to New Columns
- **Release Assignment**: Release 2 (Application Deployment)
- **Action**: Deploy application code configured as follows:
  - **Reads**: Switch to reading directly from `first_name` and `last_name`. (If an API or client still requires `full_name`, construct it dynamically in the application layer via `f"{first_name} {last_name}".strip()`).
  - **Writes**: **CONTINUE DUAL-WRITING** to both `full_name` AND (`first_name`, `last_name`).
- **Application Logic Implementation**:
  ```python
  def get_user(user_id):
      row = db.fetch_one(
          "SELECT id, first_name, last_name, email FROM users WHERE id = :id",
          {"id": user_id}
      )
      return {
          "id": row["id"],
          "first_name": row["first_name"],
          "last_name": row["last_name"],
          # Synthesize full_name for backward-compatible response contracts
          "full_name": f"{row['first_name']} {row['last_name']}".strip(),
          "email": row["email"]
      }

  def create_or_update_user(user_data):
      # Dual-write logic remains identical to Release 1
      # Both full_name and (first_name, last_name) are persisted!
      ...
  ```
- **Side-by-Side Coexistence Safety**:
  - During the rollout, Release 1 and Release 2 serve traffic concurrently.
  - **Release 1 instances** read from `full_name` and write to both `full_name` and `first_name`/`last_name`.
  - **Release 2 instances** read from `first_name`/`last_name` and write to both `full_name` and `first_name`/`last_name`.
  - Because **both releases dual-write**, any record created or modified by Release 1 is immediately readable by Release 2, and any record created or modified by Release 2 is immediately readable by Release 1.
  - All existing historical rows were already backfilled in Step 4, so Release 2 reads never encounter missing data.

#### Step 7 (Release 2): Decommission Release 1 Fleet
- **Release Assignment**: Release 2 (Post-deployment)
- **Action**: Complete the rollout and terminate all Release 1 instances. Verify that 100% of running application instances are on Release 2.

#### Step 8 (Release 2): Production Read Monitoring & Soak Period
- **Release Assignment**: Release 2 (Validation & Soak Phase)
- **Action**: Maintain Release 2 in production for a designated soak period (e.g., 24–48 hours).
- **Checks**:
  - Monitor application logs for any `null` or formatting errors relating to `first_name` or `last_name`.
  - Check database read query latency; ensure index usage on new columns is optimal if queries filter by `last_name` or `first_name`.
  - Confirm zero reads touch the `full_name` column in database access logs.

---

### Release 3: Stop Writing Old Column

#### Step 9 (Release 3): Pre-deployment Database Migration — Relax Old Constraints & Add New Constraints
- **Release Assignment**: Release 3 (Pre-deployment)
- **Action**:
  1. Drop the `NOT NULL` constraint on `full_name` (so that Release 3 instances can insert rows without providing `full_name`).
  2. Add `NOT NULL` constraints to `first_name` and `last_name` safely (using `NOT VALID` followed by `VALIDATE CONSTRAINT` to avoid exclusive table locks in PostgreSQL).
- **DDL Execution**:
  ```sql
  SET lock_timeout = '3s';

  -- 1. Allow full_name to be omitted by incoming Release 3 writes
  ALTER TABLE users ALTER COLUMN full_name DROP NOT NULL;

  -- 2. Safely enforce NOT NULL on new columns without full table lock
  ALTER TABLE users ADD CONSTRAINT check_first_name_not_null CHECK (first_name IS NOT NULL) NOT VALID;
  ALTER TABLE users VALIDATE CONSTRAINT check_first_name_not_null;

  ALTER TABLE users ADD CONSTRAINT check_last_name_not_null CHECK (last_name IS NOT NULL) NOT VALID;
  ALTER TABLE users VALIDATE CONSTRAINT check_last_name_not_null;
  ```
- **Side-by-Side Coexistence Safety**:
  - Release 2 instances are currently running and continuing to write both `full_name` and `first_name`/`last_name`.
  - Dropping `NOT NULL` on `full_name` does not affect Release 2 (providing a value for a nullable column is always valid).
  - Validating `NOT NULL` on `first_name` and `last_name` succeeds because all rows were backfilled in Step 4 and Release 2 writes both columns.

#### Step 10 (Release 3): Deploy Application Release 3 — Cease Writing to `full_name`
- **Release Assignment**: Release 3 (Application Deployment)
- **Action**: Deploy application code configured as follows:
  - **Reads**: Read only from `first_name` and `last_name`.
  - **Writes**: **STOP WRITING to `full_name`**. Write only to `first_name` and `last_name`.
- **Application Logic Implementation**:
  ```python
  def create_or_update_user(user_data):
      # Write ONLY to new columns; full_name is omitted entirely
      db.execute(
          """
          INSERT INTO users (id, first_name, last_name, updated_at)
          VALUES (:id, :first_name, :last_name, NOW())
          ON CONFLICT (id) DO UPDATE SET
              first_name = EXCLUDED.first_name,
              last_name = EXCLUDED.last_name,
              updated_at = NOW()
          """,
          {"id": user_data["id"], "first_name": user_data["first_name"], "last_name": user_data["last_name"]}
      )
  ```
- **Side-by-Side Coexistence Safety**:
  - During rollout, Release 2 and Release 3 run concurrently.
  - Release 2 reads only from `first_name` and `last_name` (switched in Step 6).
  - Release 3 reads only from `first_name` and `last_name`.
  - When Release 3 creates or updates a record, `full_name` is left NULL or stale. **This is completely safe because Release 2 no longer reads `full_name`!** Both Release 2 and Release 3 read from `first_name` and `last_name`, which Release 3 always updates.
  - Because `full_name` was made nullable in Step 9, database-level inserts from Release 3 succeed without constraint violation.

#### Step 11 (Release 3): Decommission Release 2 Fleet
- **Release Assignment**: Release 3 (Post-deployment)
- **Action**: Complete the rollout and terminate all Release 2 instances. Verify that 100% of running application instances are on Release 3.
- **Result**: There are now **zero** active processes in the entire infrastructure reading or writing to `full_name`.

#### Step 12 (Release 3): Ignore `full_name` in ORM Schema Cache
- **Release Assignment**: Release 3 (Post-deployment Application Configuration)
- **Action**: Ensure the application model/ORM explicitly ignores the `full_name` column (e.g., `ignored_columns = [:full_name]` in Rails ActiveRecord, or removing the attribute from Django/SQLAlchemy models).
- **Why this step is critical**: ORMs often issue `SELECT *` or cache table schemas on boot. If the column were dropped in the database while an app expected it in its model definition, queries could throw `column "full_name" does not exist` errors. Release 3 ensures the application has zero references to `full_name` before the physical column is dropped.

---

### Release 4: Contract & Drop Old Column

#### Step 13 (Release 4): Pre-deployment Database Migration — Drop Old Column
- **Release Assignment**: Release 4 (Pre-deployment)
- **Action**: Drop the `full_name` column from `users`.
- **DDL Execution**:
  ```sql
  SET lock_timeout = '3s';

  -- Drop any legacy views, triggers, or indices referencing full_name if present
  DROP INDEX CONCURRENTLY IF EXISTS idx_users_full_name;

  -- Drop the column
  ALTER TABLE users DROP COLUMN full_name;
  ```
- **Side-by-Side Coexistence Safety**:
  - Release 3 instances are currently serving 100% of production traffic.
  - As configured in Step 10 and Step 12, Release 3 neither selects, nor inserts, nor updates, nor references `full_name`.
  - Dropping the column while Release 3 is running causes zero errors, locks, or query failures for the active Release 3 fleet.

#### Step 14 (Release 4): Deploy Application Release 4 — Final Code Cleanup
- **Release Assignment**: Release 4 (Application Deployment)
- **Action**: Deploy application code with all legacy migration scaffolding removed:
  - Remove legacy dual-write helper functions.
  - Remove name-splitting utilities from live write paths.
  - Remove ORM column ignore directives (`ignored_columns`).
- **Side-by-Side Coexistence Safety**:
  - Release 3 and Release 4 behave identically with respect to the database: both interact solely with `first_name` and `last_name`.
  - Rolling out Release 4 side-by-side with Release 3 is completely transparent and seamless.

#### Step 15 (Release 4): Post-Deployment Database Maintenance
- **Release Assignment**: Release 4 (Post-deployment)
- **Action**: Reclaim space and update database query planner statistics.
- **Maintenance Execution**:
  ```sql
  -- Update statistics for query planner
  ANALYZE users;

  -- In PostgreSQL, standard autovacuum will reclaim space over time,
  -- or run a non-blocking vacuum during off-peak hours:
  VACUUM users;
  ```

---

## Detailed Rollback Section

Every release has a dedicated rollback procedure designed to handle:
1. **Rollback during deployment** (aborting while two versions are running side-by-side).
2. **Rollback post-deployment** (reverting after the new version has reached 100% traffic).

```
+-------------------------------------------------------------------------------------------------+
|                                    ROLLBACK DECISION TREE                                       |
+-------------------------------------------------------------------------------------------------+
| Release 1 Rollback:                                                                             |
|   - Revert app to Release 0 (reads/writes full_name).                                           |
|   - Historical data intact in full_name. DB columns first_name/last_name can be dropped later.  |
+-------------------------------------------------------------------------------------------------+
| Release 2 Rollback:                                                                             |
|   - Revert app to Release 1 (reads full_name, dual-writes both).                                |
|   - Zero data loss: Release 2 dual-wrote both columns, keeping full_name 100% fresh!            |
+-------------------------------------------------------------------------------------------------+
| Release 3 Rollback:                                                                             |
|   - Requires Data Reconciliation: Release 3 stopped writing full_name.                          |
|   - Run reconciliation script: UPDATE users SET full_name = CONCAT(...) WHERE full_name IS NULL |
|   - Revert app to Release 2. Re-apply NOT NULL on full_name if required.                        |
+-------------------------------------------------------------------------------------------------+
| Release 4 Rollback:                                                                             |
|   - POINT OF NO RETURN for physical full_name column.                                           |
|   - App can roll back to Release 3 with zero friction (Release 3 does not touch full_name).     |
|   - If full_name column is strictly needed, re-add column and reconstruct from new columns.     |
+-------------------------------------------------------------------------------------------------+
```

---

### 1. Rollback of Release 1 (Expand & Dual-Write)

#### Scenario A: Abort During Rollout (Release 0 & Release 1 coexisting)
- **Trigger**: Release 1 encounters application errors, memory leaks, or syntax bugs on startup.
- **Procedure**:
  1. Direct deployment traffic 100% back to Release 0.
  2. Terminate canary / pending Release 1 pods.
- **Data State & Safety**:
  - Release 1 dual-wrote to `full_name`, `first_name`, and `last_name`. Release 0 wrote only to `full_name`.
  - Because Release 0 only reads `full_name`, all rows inserted/updated by Release 1 have a valid `full_name` and remain fully readable by Release 0.
  - Zero data loss occurs.

#### Scenario B: Rollback After 100% Deployment (Before Step 6)
- **Trigger**: Issue discovered after Release 1 has fully rolled out (e.g., dual-write performance degradation).
- **Procedure**:
  1. Deploy previous stable build (Release 0).
  2. Halt the backfill job (Step 4) if it is running.
  3. Release 0 resumes reading and writing exclusively to `full_name`.
  4. (Optional Cleanup) Drop columns `first_name` and `last_name` after Release 0 is stable:
     ```sql
     ALTER TABLE users DROP COLUMN IF EXISTS first_name;
     ALTER TABLE users DROP COLUMN IF EXISTS last_name;
     ```

---

### 2. Rollback of Release 2 (Switch Reads)

#### Scenario A: Abort During Rollout (Release 1 & Release 2 coexisting)
- **Trigger**: Queries reading `first_name` and `last_name` fail or exhibit slow execution plans.
- **Procedure**:
  1. Route traffic 100% back to Release 1.
  2. Terminate Release 2 instances.
- **Data State & Safety**:
  - Both Release 1 and Release 2 dual-write to both `full_name` and `first_name`/`last_name`.
  - Any writes processed by Release 2 populated `full_name`.
  - When traffic reverts to Release 1, Release 1 reads `full_name`, which is completely up-to-date.
  - Zero data loss, zero reconciliation required.

#### Scenario B: Rollback After 100% Deployment (Release 2 running alone)
- **Trigger**: Regressions discovered in business logic that consumes `first_name`/`last_name`.
- **Procedure**:
  1. Redeploy Release 1 application code.
  2. Release 1 immediately reads from `full_name` and continues dual-writing to both columns.
  3. No database changes or data repairs are needed because `full_name` was maintained continuously during Release 2.

---

### 3. Rollback of Release 3 (Stop Writing Old Column)

#### Scenario A: Abort During Rollout (Release 2 & Release 3 coexisting)
- **Trigger**: Release 3 deployment encounters errors while scaling up.
- **Procedure**:
  1. Route traffic 100% back to Release 2.
  2. Terminate Release 3 instances.
  3. **Immediate Data Reconciliation**: During the window Release 3 was running, any new rows or updates created by Release 3 wrote only `first_name` and `last_name`, leaving `full_name` NULL.
     Run the following repair query immediately:
     ```sql
     -- Re-populate full_name for rows touched by Release 3
     UPDATE users
     SET full_name = TRIM(CONCAT(first_name, ' ', last_name))
     WHERE full_name IS NULL
        OR full_name != TRIM(CONCAT(first_name, ' ', last_name));
     ```
  4. Once reconciled, Release 2 can safely read and write all rows.

#### Scenario B: Rollback After 100% Deployment (Release 3 running alone)
- **Trigger**: Critical legacy integration discovered that still depends on `full_name` at the database level.
- **Procedure**:
  1. **Step 1 (Data Sync)**: Execute the reconciliation script to backfill `full_name` for all records modified during Release 3:
     ```sql
     UPDATE users
     SET full_name = TRIM(CONCAT(first_name, ' ', last_name))
     WHERE full_name IS NULL
        OR full_name != TRIM(CONCAT(first_name, ' ', last_name));
     ```
  2. **Step 2 (App Rollback)**: Redeploy Release 2 (which dual-writes both `full_name` and `first_name`/`last_name`).
  3. **Step 3 (Re-apply Constraint if required)**:
     ```sql
     ALTER TABLE users ALTER COLUMN full_name SET NOT NULL;
     ```

---

### 4. Rollback of Release 4 (Contract & Drop Old Column)

#### Point of No Return
Dropping the column in **Step 13** is the **structural point of no return** for physical storage:
- Once `ALTER TABLE users DROP COLUMN full_name;` executes, the data in `full_name` is deleted from disk.
- However, **application rollback to Release 3 is 100% safe and instant**:
  - Release 3 does not reference `full_name`.
  - If Release 4 application code experiences bugs, rolling back to Release 3 requires **no database restore** because Release 3 operates exclusively on `first_name` and `last_name`.

#### Disaster Recovery: Restoring `full_name` Column if Rolled Back Past Release 3
If an extreme catastrophic emergency requires rolling all the way back to Release 2 or Release 1 after the column was dropped:
1. Re-add the column as nullable:
   ```sql
   ALTER TABLE users ADD COLUMN full_name VARCHAR(512) NULL;
   ```
2. Reconstruct `full_name` data from `first_name` and `last_name`:
   ```sql
   UPDATE users
   SET full_name = TRIM(CONCAT(first_name, ' ', last_name));
   ```
3. Re-add constraints once populated:
   ```sql
   ALTER TABLE users ALTER COLUMN full_name SET NOT NULL;
   ```
4. Deploy Release 2 or Release 1.

---

## Operational Verification & Monitoring Checklist

Before proceeding between releases, operations and engineering leads must sign off on the following telemetry:

- [ ] **Release 1 Gate**:
  - [ ] Zero database statement timeouts on `ALTER TABLE users ADD COLUMN`.
  - [ ] Replication lag between primary and read replicas remains $< 1.0$s during backfill.
  - [ ] Audit query confirms `COUNT(*) WHERE first_name IS NULL` is exactly `0`.
- [ ] **Release 2 Gate**:
  - [ ] Read error rate on user profile endpoints is $0.00\%$.
  - [ ] Dual-write database transaction latency is within SLA ($< 15$ms p95).
  - [ ] Zero active application queries referencing `full_name` in `SELECT` clauses.
- [ ] **Release 3 Gate**:
  - [ ] `NOT NULL` constraints on `first_name` and `last_name` successfully validated without locks.
  - [ ] No database exceptions observed from Release 3 instances omitting `full_name`.
  - [ ] Application telemetry confirms complete retirement of Release 2 instances before proceeding to Release 4.
- [ ] **Release 4 Gate**:
  - [ ] Verified that no external reporting tools, ETL pipelines, or analytics read replicas query `full_name`.
  - [ ] `ALTER TABLE users DROP COLUMN full_name;` completes within 3-second lock timeout.
  - [ ] `ANALYZE users` executed to refresh query planner stats.
