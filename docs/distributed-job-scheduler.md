# Distributed Job Scheduler Architecture

The scheduler stores every unit of work in `scheduled_jobs` and lets stateless workers claim jobs with short database leases. Claims run inside a single transaction and use row locks with `SKIP LOCKED`, so competing workers never process the same row while avoiding global locks.

## Critical path

1. Workers query due jobs where `status = queued` or an old `leased` row has `lease_expires_at < now()`.
2. The claim transaction locks candidates, sets `worker_id`, `lease_token`, `leased_at`, and a new `lease_expires_at`, then commits.
3. Workers heartbeat long-running jobs before the lease expires.
4. Completion, failure, and heartbeat updates include `worker_id` and `lease_token` predicates to fence stale workers.

The indexed claim predicate keeps the P99 target below 100 ms under normal database latency. Workers should keep claim batches small and horizontally scale by adding replicas.

## Availability and deployment

The scheduler is safe for blue-green deployments because leases are data-backed and expire automatically. During canary rollout, run a small percentage of green workers with the same queue table and compare claim latency, retry rate, and stale lease counts before increasing traffic.

## Security

Lease tokens are UUID capabilities and are never accepted from public APIs. Job payloads must be validated by job-specific handlers, and idempotency keys should be used for externally triggered work.
