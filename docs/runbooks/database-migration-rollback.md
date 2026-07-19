# Runbook: Database Migration Rollback

## When to use

Use this runbook when a recently deployed migration causes elevated error rates, failed health checks, or canary analysis failure.

## Steps

1. Freeze traffic shifting and keep the current blue environment serving production traffic.
2. Identify the last applied migration in `schema_migrations`.
3. Run `MIGRATION_STEPS=1 npm run migrate:rollback` from the same release artifact.
4. Verify that application health checks pass and pending migration counts match the expected state.
5. Record the incident, failed migration version, rollback duration, and follow-up fix-forward plan.

## Validation queries

```sql
SELECT version, name, applied_at, rolled_back_at
FROM schema_migrations
ORDER BY applied_at DESC
LIMIT 10;
```

## Escalation

Escalate to the database owner if rollback SQL is missing, if rollback exceeds the deploy window, or if a data migration requires point-in-time recovery.
