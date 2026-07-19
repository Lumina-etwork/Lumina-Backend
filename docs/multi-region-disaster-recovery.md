# Multi-Region Replication and Disaster Recovery Architecture

## Goals

- Keep critical API paths below **100 ms P99** by routing reads to the nearest healthy replica and keeping writes single-writer.
- Maintain **99.99% availability** through regional redundancy, automated health checks, and controlled traffic shifts.
- Bound data loss and recovery with a default **RPO of 60 seconds** and **RTO of 300 seconds**.
- Preserve security reviewability by requiring explicit promotion guardrails before write leadership changes.

## Architecture

Lumina uses a single-writer, multi-reader topology:

1. The primary region accepts all writes for PostgreSQL-backed state, vault mutations, claim processing, webhooks, and reconciliation jobs.
2. Replica regions consume PostgreSQL streaming replication plus WAL archive restore points.
3. Read-only API requests can use latency-aware routing to regional read replicas when the data freshness budget allows it.
4. Redis, queues, and job workers are region-scoped. Only the active write region runs mutating workers.
5. Stellar/Soroban RPC clients are configured per region and guarded by circuit breakers so failover does not cascade through degraded RPC endpoints.

## Core Logic

`MultiRegionDrService` provides deterministic topology validation, region health scoring, and failover plan generation. Promotion is only recommended when a replica is healthy, replication lag is below the configured threshold, critical-path P99 latency remains within the 100 ms target, and backups satisfy the RPO window.

The service is exposed under `/api/dr`:

- `POST /api/dr/topology` validates and normalizes a primary-plus-replicas topology.
- `POST /api/dr/health/evaluate` evaluates a single region snapshot against promotion guardrails.
- `POST /api/dr/failover-plan` returns either a replica promotion plan or a manual-intervention decision.

## Monitoring and Alerts

Track these signals per region and service:

| Signal | Warning | Critical | Action |
| --- | ---: | ---: | --- |
| Critical API P99 latency | 80 ms | 100 ms | Reduce canary weight or route reads locally. |
| PostgreSQL replication lag | 2 s | 5 s | Pause promotion and inspect WAL shipping. |
| Last verified backup age | 45 s | 60 s | Force backup and block failover automation. |
| Active write workers per region | > 1 | > 1 for 60 s | Fence duplicate writers immediately. |
| Synthetic health checks | 1 failed | 3 failed | Start canary rollback or DR assessment. |

Dashboards should group panels by region and include API latency, database lag, queue depth, Stellar RPC error rate, active deployment color, and failover decision state.

## Deployment Strategy

1. Deploy the passive region first with workers disabled and read traffic at 0%.
2. Run synthetic checks and `/api/dr/health/evaluate` against the passive region.
3. Shift read-only traffic with canary weights of 1%, 10%, 25%, 50%, and 100% while watching P99 latency and error budgets.
4. Keep writes pinned to the primary unless a failover plan explicitly promotes a replica.
5. After promotion, enable mutating workers in the new primary and confirm old-primary fencing before unfreezing writes.
