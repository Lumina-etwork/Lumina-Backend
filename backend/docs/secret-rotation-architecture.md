# Secret Rotation Service Architecture

## Goals

The Secret Rotation Service rotates database credentials and API keys without service-wide downtime while preserving the critical-path target of **<100ms P99**. Runtime request handlers continue to read secrets through the cached `secretsService`; rotation happens asynchronously in a background job and clears the cache only after a candidate secret is promoted.

## Components

- `SecretRotationService`: owns the rotation registry, per-secret locking, candidate generation, canary plan construction, promotion, revocation, auditing, and metrics.
- `SecretRotationJob`: periodically scans registered secrets when `SECRET_ROTATION_ENABLED=true`.
- `metricsService`: exposes Prometheus counters, gauges, and histograms for rotation attempts, failures, duration, and latest health.
- Existing `secretsService`: remains the read path for Vault, AWS Secrets Manager, and environment fallbacks.

## Rotation Workflow

1. Register each database credential or API key with provider callbacks for candidate write, validation, promotion, and previous-version revocation.
2. Generate a candidate version using a provider-specific generator or a 48-byte cryptographic random value.
3. Write the candidate to the secret provider's staging slot.
4. Validate connectivity or API-key usability against the candidate before promotion.
5. Promote the candidate through a blue-green/canary plan. The default canary shifts 10% of compatible consumers first and requires P99 latency to remain under 100ms during analysis.
6. Revoke the previous version after promotion succeeds.
7. Clear local secret caches so new reads pick up the promoted credential.
8. Emit audit events and Prometheus metrics.

## Availability and Rollback

The rotation job uses per-secret locks, so concurrent scans cannot rotate the same secret twice. Failed validation or promotion leaves the previous version active, marks `secret_rotation_status` as unhealthy, and increments failure counters for alerting. Blue-green deployments should roll out secret consumers with both old and candidate credentials accepted during the canary window, then revoke old credentials only after promotion.

## Security Notes

- Secret values are never included in audit metadata or metrics labels.
- Generated values use Node.js `crypto.randomBytes`.
- Provider integrations should use least-privilege IAM/Vault policies: read current, write staging, promote, and revoke only for registered secret paths.
- Security review should verify callback implementations, provider ACLs, dashboard access, and runbook rollback steps before enabling production rotation.

## Monitoring and Alerts

Alert when any of the following occur:

- `secret_rotation_status == 0` for a production secret.
- `increase(secret_rotation_failures_total[15m]) > 0`.
- `histogram_quantile(0.99, rate(secret_rotation_duration_seconds_bucket[5m])) > 0.1` for latency-sensitive credentials.
- No successful rotation within the expected interval plus grace period.

Dashboard panels should show attempts, failures, current status by provider/type, P50/P95/P99 rotation duration, and canary promotion outcomes.
