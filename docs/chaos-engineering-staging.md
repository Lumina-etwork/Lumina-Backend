# Chaos Engineering Testing Blueprint for Staging

## Goals and guardrails

This blueprint defines how Lumina runs controlled chaos experiments in staging before production release. The program validates that critical paths remain below the 100 ms P99 latency target, that the service model can support the 99.99% availability objective, and that every experiment is auditable for security review before it is scheduled.

Chaos testing is only allowed in the staging namespace. Experiments must be disabled by default, require an explicit change ticket, and run from a least-privilege service account that can target only approved staging workloads.

## Architecture

The staging chaos system has five layers:

1. **Experiment catalog**: versioned scenarios covering API, database, cache, queue, websocket, Kubernetes, and third-party RPC failure modes.
2. **Orchestrator**: a CI or runbook-triggered job that loads the catalog, checks guardrails, executes experiments, and writes evidence artifacts.
3. **Injection adapters**: Kubernetes, network, process, and dependency adapters that apply latency, packet loss, pod termination, CPU pressure, connection reset, and dependency error injections.
4. **Observability plane**: Prometheus, OpenTelemetry traces, structured logs, Sentry events, and dashboard snapshots collected before, during, and after each experiment.
5. **Release gate**: canary analysis blocks blue-green promotion when any critical path exceeds 100 ms P99, error budget burn exceeds the configured threshold, or recovery objectives are missed.

## Experiment matrix

| Scenario | Target | Injection | Success criteria | Abort condition |
| --- | --- | --- | --- | --- |
| API latency | Public API pods | Add 50-250 ms latency to 10% of requests | Critical endpoints stay below 100 ms P99 after retry/circuit-breaker mitigation | P99 exceeds 100 ms for 5 minutes |
| Database brownout | Postgres staging primary | Add connection refusal and 100 ms query latency windows | Circuit breaker opens, read-only fallback works, no data corruption | Write failure rate exceeds 1% |
| Redis degradation | Cache nodes | Drop 20% cache operations | Cache misses degrade gracefully and API availability remains above 99.99% projection | Queue backlog grows for 3 consecutive checks |
| Stellar RPC outage | External RPC clients | Return 429/5xx and timeout responses | RPC retry policy backs off and user-facing requests receive deterministic status | Retry storm or provider rate-limit alarm fires |
| Websocket churn | Websocket pods | Kill 25% of pods during active sessions | Clients reconnect and subscriptions resync without duplicate events | Reconnect success rate below 99% |
| Kubernetes node drain | Staging worker node | Cordon and drain one node | Pod disruption budgets preserve quorum and traffic shifts to healthy pods | More than one replica unavailable per service |

## Monitoring, alerting, and dashboards

Each experiment must emit a `chaos_experiment` event with experiment id, service, injection type, blast radius, start time, end time, owner, ticket, and rollback command. Dashboards should include:

- Golden signals: request rate, error rate, latency P50/P95/P99, saturation, and availability projection.
- Dependency health: database pool exhaustion, Redis command failures, queue backlog, external RPC status, and circuit-breaker state.
- Recovery indicators: time to detect, time to mitigate, time to recover, and replay/duplicate-event counts.
- Security evidence: actor identity, service account, RBAC scope, approved ticket, and audit log link.

Alerts should page the staging incident channel when abort conditions are reached and should automatically annotate blue-green and canary dashboards.

## Blue-green and canary integration

Chaos experiments run against the inactive color first. If the inactive color passes, route 5% of staging traffic to that color and run dependency brownout scenarios. Promotion to 50% and then 100% is allowed only when the canary analyzer confirms:

- P99 latency for critical paths is below 100 ms.
- Projected availability remains at or above 99.99%.
- Error budget burn is below the release threshold.
- No high-severity security or data-integrity alerts fire.

Failed analysis immediately routes traffic back to the stable color and stores the evidence bundle with the deployment id.

## Runbook

1. Confirm the change ticket, owner, staging window, and rollback command.
2. Run `node scripts/chaos-staging-plan.js --validate` to validate the experiment catalog.
3. Announce the experiment in the staging incident channel.
4. Capture baseline dashboard snapshots for at least 15 minutes.
5. Execute one experiment at a time with the smallest blast radius.
6. Watch abort conditions continuously and stop immediately if a guardrail fails.
7. Capture post-experiment metrics for at least 15 minutes.
8. Attach logs, dashboard links, trace exemplars, and the generated plan to the release ticket.
9. Update the experiment status as passed, failed, or quarantined.

## Security review checklist

- Experiment scope is limited to staging and approved namespaces.
- RBAC denies production workloads and secrets unrelated to the target service.
- No experiment disables authentication, authorization, audit logging, encryption, or rate limiting.
- Evidence artifacts do not include plaintext secrets, private keys, session tokens, or raw PII.
- Rollback commands and abort thresholds were reviewed before execution.
