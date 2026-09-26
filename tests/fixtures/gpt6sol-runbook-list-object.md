# Restart a Stuck Message Queue Consumer

## Purpose

Restore message processing for a consumer that has stopped making progress.

## Preconditions

- Confirm that the consumer lag increases while incoming messages arrive.
- Identify the consumer service, queue, deployment environment, and owning team.
- Obtain access to the service manager and monitoring dashboard.
- Check the service logs for errors that require escalation before restart.
- Confirm that another worker can process messages during the restart, if availability requires it.
- Record the current replica count and consumer offset.

## Steps

1. Notify the owning team of the planned restart.
2. Capture recent consumer logs and current lag metrics.
3. Stop the affected consumer through the approved service manager.
4. Wait until the service manager reports the consumer as stopped.
5. Start the affected consumer through the approved service manager.
6. Record the restart time.

## Verification

- Confirm that the service manager reports the consumer as healthy.
- Confirm that the consumer advances its offset.
- Confirm that queue lag decreases over the team's standard observation period.
- Check logs for repeated failures or duplicate processing errors.
- Notify the owning team when processing resumes.

## Rollback

- Stop the restarted consumer if it repeatedly fails or processes messages incorrectly.
- Restore the previous replica count if the restart changed it.
- Escalate to the owning team before changing offsets or acknowledging messages manually.
- Preserve logs and metrics for incident review.
