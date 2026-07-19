# Dead Letter Queue Runbook

## Alerts

Page the owning service team when `dlq_messages_total` increases for a critical queue for 5 minutes or any `dlq_capture_failures_total` sample is non-zero.

## Triage

1. Check `/metrics` for `dlq_messages_total`, grouped by `source_queue`, `job_name`, and `reason`.
2. Inspect the `system-dead-letter` BullMQ queue for the failed payload hash, failure reason, and source job id.
3. Confirm downstream dependencies are healthy before replaying messages.
4. Replay a single message first and verify the replacement job completes.

## Replay Safety

- Prefer idempotent workers and source job de-duplication before bulk replay.
- Do not replay truncated payload entries until the full payload has been reconstructed from an approved secure source.
- During blue-green rollback, leave the DLQ queue intact and pause only source queues that are still failing.
