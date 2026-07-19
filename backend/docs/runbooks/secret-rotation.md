# Secret Rotation Runbook

## Enablement

1. Configure provider callbacks for each database credential and API key.
2. Deploy code to the green environment with `SECRET_ROTATION_ENABLED=false`.
3. Run dry-run rotations in green and verify audit logs plus Prometheus metrics.
4. Enable `SECRET_ROTATION_ENABLED=true` for a small canary.
5. Promote green after canary analysis confirms P99 latency remains below 100ms and no rotation failures are present.

## Manual Rotation

1. Put the target secret into maintenance watch in the incident channel.
2. Trigger `SecretRotationService.rotateSecret(name)` from an admin job or controlled script.
3. Confirm `secret_rotation_status{secret_type,provider}=1`.
4. Confirm dependent services reconnect with the promoted version.
5. Revoke previous credentials only after validation completes.

## Rollback

1. Disable `SECRET_ROTATION_ENABLED` to stop new rotations.
2. Re-promote the previous provider version if candidate promotion caused errors.
3. Clear application secret caches.
4. Roll traffic back from green to blue if canary metrics regress.
5. Open a security review if a rotated secret might have been exposed.
