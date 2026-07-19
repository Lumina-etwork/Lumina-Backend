# Dead Letter Queue Architecture

## Goals

The system-wide dead letter queue (DLQ) isolates messages that have exhausted all retry attempts so critical API paths remain under the 100 ms P99 target and operators can replay failures safely.

## Design

- Every BullMQ-backed worker attaches a `QueueEvents` failure listener through `DeadLetterQueueService`.
- A job is copied to the `system-dead-letter` queue only after `attemptsMade >= attempts`, preventing transient failures from creating DLQ noise.
- DLQ entries include source queue, source job id, source job name, retry counts, truncated payload, SHA-256 payload hash, failure reason, and bounded stack trace.
- Payloads larger than `DLQ_MAX_PAYLOAD_BYTES` are replaced with hash and byte-count metadata to reduce sensitive-data exposure and avoid Redis bloat.
- Replays create a fresh source-queue job with a `dlq-retry:*` id and annotate the DLQ entry with replay metadata.

## Operational Characteristics

- Hot path overhead is event-driven and out of band from request handlers.
- Metrics are exported through the existing Prometheus `/metrics` endpoint.
- DLQ retention defaults to 14 days and is configurable with `DLQ_RETENTION_DAYS`.
- Blue-green deploys can enable the DLQ listener first on canary workers, verify `dlq_capture_failures_total == 0`, then roll forward.

## Security Notes

- No import-time try/catch is used.
- Error messages are capped at 2 KiB and stack traces are limited to the last three frames.
- Oversized payloads are not stored verbatim; operators use the SHA-256 hash to correlate with secure logs.
