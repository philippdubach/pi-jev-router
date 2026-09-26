# Purpose

Restore a stuck message queue consumer while protecting messages from loss or duplicate processing.

# Preconditions

- Obtain permission to restart the consumer.
- Identify the consumer deployment, queue, environment, and owning team.
- Confirm that the queue retains unacknowledged messages during a consumer restart.
- Check the service procedure for handling in-flight messages.
- Confirm that no deployment or maintenance task affects the consumer.
- Locate the approved restart command for the deployment platform.
- Record the current replica count, consumer lag, error rate, and restart count.

# Steps

1. Notify the owning team about the planned restart.
2. Inspect consumer logs for errors that require a different recovery procedure.
3. Stop this procedure if the logs show data corruption or repeated processing failures.
4. Record the consumer's last acknowledged message position when the platform exposes it.
5. Restart one affected consumer instance with the approved platform command.
6. Wait for that instance to report a healthy state.
7. Repeat the restart for other affected instances one at a time if necessary.

# Verification

- Confirm that each restarted instance reports a healthy state.
- Confirm that the consumer resumes acknowledging messages.
- Compare consumer lag with the recorded baseline.
- Check that lag decreases over the normal processing interval.
- Check logs for repeated errors or duplicate-processing warnings.
- Notify the owning team of the result.

# Rollback

- Stop further restarts if errors increase or message acknowledgments stop.
- Restore the previous deployment revision if the restart changed the running revision.
- Restore the previous replica count if the restart changed it.
- Escalate to the owning team if the consumer remains stuck.
- Preserve logs, timestamps, and message positions for investigation.
