# Audit Hash Chain Runbook

## Blue-green rollout

1. Deploy the database migration to the green environment.
2. Backfill legacy audit rows in chronological order if existing `admin_audit_logs` rows are present.
3. Run `GET /api/audit-trail/verify?limit=50000` against green and confirm `valid: true`.
4. Shift 5% of traffic to green for 30 minutes and compare `audit_events_total{result="error"}` and request latency with blue.
5. Promote green only if verification remains valid and P99 latency stays within target.

## Incident response

1. Freeze destructive admin operations.
2. Run a narrowed verification with `from` and `to` parameters to identify the first mismatch.
3. Export the invalid row, the previous row, and the database WAL segment for security review.
4. Rotate admin credentials if unauthorized modification is suspected.
5. Restore from the last verified backup or rebuild the chain from immutable event exports.
