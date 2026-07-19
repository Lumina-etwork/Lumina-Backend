# Distributed Job Scheduler Runbook

## Alerts

- `SchedulerClaimLatencyHigh`: P99 of `scheduler_claim_latency_seconds` exceeds 100 ms for 10 minutes.
- `SchedulerFailureRateHigh`: failed jobs increase rapidly for 5 minutes.
- `SchedulerStaleLeases`: leased jobs with expired leases continue rising.

## Triage

1. Check database health, write latency, and lock wait metrics.
2. Inspect queued and leased job counts grouped by type and status.
3. Pause noisy producers if one job type dominates queue depth.
4. Restart unhealthy workers only after confirming leases will expire or have expired.

## Recovery

- Stale leases are self-healing; a healthy worker can reclaim them after `lease_expires_at`.
- For poisoned jobs, set `status = failed` and record the incident ticket in `last_error`.
- For blue-green rollback, scale green workers to zero; blue workers can reclaim any expired green leases.
