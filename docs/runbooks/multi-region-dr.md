# Multi-Region Disaster Recovery Runbook

## Failover Drill

1. Announce the drill window and freeze non-emergency deployments.
2. Capture `/api/dr/failover-plan` output with current region health snapshots.
3. If the decision is `promote_replica`, fence primary writes and verify no mutating workers are active outside the target region.
4. Promote the target database and update application secrets/configuration to the promoted writer endpoint.
5. Shift traffic with the blue-green controller, starting at 1% canary and increasing only when P99 latency remains below 100 ms.
6. Run vault reconciliation, ledger reorg checks, webhook replay checks, and claim idempotency checks.
7. Unfreeze writes only after SLOs, backups, and security audit logs are green.

## Rollback

1. Stop canary promotion if P99 latency exceeds 100 ms, replication lag exceeds 5 seconds, or synthetic checks fail three times.
2. Drain traffic from the candidate region.
3. Keep writes frozen until a database administrator confirms the authoritative writer.
4. Resume the previous primary only if it has not accepted divergent writes.

## Evidence to Attach to Security Review

- Failover plan JSON and health snapshots.
- Database promotion logs and fencing confirmation.
- Blue-green/canary traffic-shift audit trail.
- Reconciliation and webhook replay results.
- Post-drill incident notes, even when no customer impact occurred.
