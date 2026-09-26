# Incident Runbook: Network Partition Recovery (Database, Message Queue, API Gateway, Cache)

## Scope

This runbook covers recovery of four systems degraded by a network partition:
the **database**, the **message queue**, the **API gateway**, and the **cache**.
Steps must be executed strictly in order. Do not skip ahead — later steps
depend on earlier steps being confirmed complete first.

## Recovery Steps

1. Confirm the network partition has cleared at the infrastructure layer
   (routing tables, security groups, inter-AZ/inter-region connectivity) and
   declare the network topology stable before touching any application
   system. Owner: Network Engineer

2. Reconnect and restore the database cluster: resolve any split-brain state,
   confirm a single primary is elected, and let replicas resync from the
   restored primary. Owner: Database Administrator

3. **Verification step:** Confirm database health — replication lag is
   within normal thresholds, data integrity checks pass, and read/write
   queries succeed from a test client. Do not proceed to cache warming until
   this step passes. Owner: Database Administrator

4. Restore the message queue cluster: rejoin any partitioned broker nodes,
   confirm quorum/leader election is stable, and verify no messages were
   lost or duplicated during the partition (check dead-letter and replay
   queues as needed). Owner: Messaging Engineer

5. Restore the API gateway: reconnect it to healthy upstream database and
   message queue endpoints, reload routing/service-discovery configuration,
   and confirm health checks pass for all backend routes. Owner: Platform
   Engineer

6. Warm and repopulate the cache. This step must only begin after Step 3
   (database confirmed healthy) has passed, since cache entries are sourced
   from the database and warming against unverified data risks serving
   stale or corrupt values. Owner: Cache Engineer

7. Run a full end-to-end verification pass across all four systems: submit
   synthetic transactions through the API gateway, confirm they persist to
   the database, flow correctly through the message queue, and that cache
   reads match current database state. Owner: Site Reliability Engineer
   (Incident Commander)

## Rollback

If any step above fails verification, roll back in reverse order of
dependency to avoid serving inconsistent or stale data:

1. **Cache:** Immediately flush/disable the cache layer (fail open to the
   database) if cache data is found to be stale or inconsistent with the
   database. Owner: Cache Engineer

2. **API Gateway:** Revert routing/configuration changes to the last known
   good version and re-point traffic away from unhealthy upstreams, or
   enable maintenance-mode responses if no healthy upstream exists. Owner:
   Platform Engineer

3. **Message Queue:** If quorum cannot be re-established or data loss is
   detected, isolate the affected broker nodes, halt consumer processing to
   prevent propagating bad data, and restore from the last known good
   broker snapshot. Owner: Messaging Engineer

4. **Database:** If integrity checks fail, fail back to the last known
   healthy primary/replica snapshot and halt writes until a clean recovery
   point is confirmed. Owner: Database Administrator

5. Notify all stakeholders of the rollback and re-enter this runbook at
   Step 1 once the underlying network issue is reconfirmed resolved. Owner:
   Incident Commander
