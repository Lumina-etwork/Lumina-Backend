# Per-Tenant Token Bucket Rate Limiting Runbook

## Architecture

All `/api` traffic passes through `tenantRateLimitMiddleware`, which resolves a tenant from `x-tenant-id`, `x-organization-id`, authenticated API-key metadata, authenticated user metadata, or the `anonymous` fallback. Each tenant receives an isolated token bucket so noisy tenants cannot drain capacity for others.

Default limits are controlled by environment variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `TENANT_RATE_LIMIT_CAPACITY` | `600` | Burst tokens for standard API routes. |
| `TENANT_RATE_LIMIT_REFILL_PER_SECOND` | `10` | Sustained refill rate for standard API routes. |
| `TENANT_AUTH_RATE_LIMIT_CAPACITY` | `60` | Burst tokens for `/api/auth` routes. |
| `TENANT_AUTH_RATE_LIMIT_REFILL_PER_SECOND` | `1` | Sustained refill rate for `/api/auth` routes. |
| `TENANT_RATE_LIMIT_MAX_BUCKETS` | `50000` | In-memory bucket cap before idle pruning. |

## Monitoring and Alerts

Scrape `tenant_rate_limit_decisions_total{tenant_id,decision}` and alert when a tenant's blocked ratio is above 20% for 5 minutes or when aggregate blocks spike during a canary.

Suggested PromQL:

```promql
sum by (tenant_id) (rate(tenant_rate_limit_decisions_total{decision="blocked"}[5m]))
/
sum by (tenant_id) (rate(tenant_rate_limit_decisions_total[5m])) > 0.20
```

## Deployment

1. Deploy to the green environment with production-equivalent limits.
2. Shift 5% of traffic for 15 minutes and compare P99 latency, 429 rate, and error rate with blue.
3. Increase to 25%, 50%, and 100% if canary analysis shows no regression.
4. Roll back by shifting traffic to blue and disabling the middleware with the previous deployment artifact.

## Operational Checks

- Confirm responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `X-RateLimit-Policy`.
- Confirm blocked requests include `Retry-After` and the `TENANT_RATE_LIMIT_EXCEEDED` error code.
- During incidents, temporarily raise tenant capacity/refill variables for known trusted tenants and redeploy through the standard blue-green flow.
