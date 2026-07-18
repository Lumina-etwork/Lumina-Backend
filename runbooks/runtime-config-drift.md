# Runtime Configuration Drift Runbook

## Impact

Runtime configuration drift can route traffic to the wrong dependency, weaken security controls, or invalidate canary assumptions.

## Detection

1. Check the Prometheus alert `RuntimeConfigDriftDetected`.
2. Query the affected pod: `curl -fsS http://<pod-ip>:4000/api/audit/runtime-config`.
3. Compare the returned drift keys with the intended deployment manifest and secret version.

## Mitigation

1. If the green/canary environment is drifting, stop promotion and keep traffic on blue.
2. If production is drifting, roll back to the last known-good ConfigMap and Secret set.
3. Rotate any secret that was accidentally deployed to the wrong environment.
4. Re-run the audit endpoint and verify `runtime_config_drift_keys` returns `0`.

## Security Review

Do not paste raw secret values into tickets. Audit responses redact sensitive values and include only presence, length, and SHA-256 fingerprints for comparison.
