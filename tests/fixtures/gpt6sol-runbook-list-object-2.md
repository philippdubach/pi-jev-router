# Purpose

Restore a stuck message queue consumer without losing messages.

# Preconditions

- Confirm that the consumer has stopped acknowledging messages.
- Identify the consumer deployment, queue, environment, and consumer group.
- Confirm that you have permission to restart the consumer.
- Check the queue depth and dead-letter queue depth.
- Record the current consumer offset or checkpoint.
- Check for an active incident or planned maintenance.

# Steps

1. Record the consumer instance ID and current restart count.
2. Inspect recent consumer logs for errors.
3. Check the broker connection status.
4. Pause the consumer deployment if your platform supports pausing.
5. Stop the stuck consumer instance through the deployment manager.
6. Wait for the instance to exit.
7. Start one replacement consumer instance through the deployment manager.
8. Resume the deployment if you paused it.
9. Record the replacement instance ID.

# Verification

- Confirm that the replacement instance reports a healthy status.
- Confirm that the replacement instance acknowledges new messages.
- Check that the consumer offset advances.
- Check that queue depth decreases under normal traffic.
- Check that the dead-letter queue depth does not increase unexpectedly.
- Inspect logs for repeated errors or duplicate processing.

# Rollback

- Stop the replacement instance if it fails health checks or processes messages incorrectly.
- Restore the previous deployment version if the restart introduced a fault.
- Leave the consumer stopped if processing risks data corruption.
- Escalate to the queue owner with the recorded offsets and logs.
