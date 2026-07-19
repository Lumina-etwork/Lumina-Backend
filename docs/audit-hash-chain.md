# Audit Trail Hash Chain Architecture

The administrative audit trail is protected with a tamper-evident SHA-256 hash chain. Each `admin_audit_logs` record now includes a monotonic `sequence_number`, the previous record's `previous_hash`, and its own `audit_hash`.

## Write path

`AuditService.logAction` reads the current chain head, increments the sequence number, canonicalizes the audit payload with stable key ordering, and stores the digest. This keeps the write path bounded to one indexed head lookup and one insert so critical request paths remain below the 100ms P99 target when the database is healthy.

## Verification path

`GET /api/audit-trail/verify` verifies a bounded window of audit records by recomputing each digest and comparing each `previous_hash` to the prior entry's `audit_hash`. A valid response returns HTTP 200; a mismatch returns HTTP 409 with the first invalid sequence.

## Monitoring and alerts

Prometheus metrics exported by the backend:

- `audit_events_total{action,result}` counts successful and failed audit writes.
- `audit_hash_chain_verifications_total{result}` counts valid and invalid verification runs.
- `audit_hash_chain_verified_entries` reports the entries checked during the latest run.

Page security operations when any verification result is `invalid` or when audit write errors increase for five minutes.
