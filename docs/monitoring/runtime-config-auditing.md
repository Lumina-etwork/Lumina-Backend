# Runtime Configuration Auditing and Drift Detection

## Architecture

Runtime configuration auditing runs inside the API process and is intentionally read-only. The service builds a deterministic snapshot from a bounded allow-list of critical environment keys, redacts sensitive values, and calculates a SHA-256 hash over the normalized values. The audit path avoids network and database calls so it remains below the 100ms P99 target for critical paths.

## API

- `GET /api/audit/runtime-config` runs an audit and returns `200` when healthy or `409` when drift is detected.
- `GET /api/audit/runtime-config/last` returns the last audit result.
- `POST /api/audit/runtime-config/baseline` captures an in-memory baseline for the running instance.

## Configuration

- `CONFIG_AUDIT_KEYS`: comma-separated key allow-list. Defaults cover runtime, database, Redis, Soroban, JWT, and observability settings.
- `CONFIG_AUDIT_EXPECTED_HASH`: optional deployment-provided snapshot hash used for immutable release drift detection.

## Monitoring

Prometheus metrics exported from `/metrics`:

- `runtime_config_audit_duration_seconds`: audit duration histogram with a 100ms SLO bucket.
- `runtime_config_drift_keys`: current count of keys drifting from baseline.
- `runtime_config_audit_status{status="healthy|drift_detected"}`: one-hot health status.
- `runtime_config_drift_detected_total`: cumulative drift detections.

## Deployment

Blue-green and canary rollout gates should query `GET /api/audit/runtime-config` on each candidate pod before traffic shift. Promote the green environment only when all candidate pods return healthy results and the Prometheus alert below remains inactive for the canary window.
