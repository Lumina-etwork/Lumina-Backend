# Service Level Objective Monitoring and Burn Rate Architecture

## Objectives

Lumina's system-wide SLO target is 99.99% availability over a 30-day compliance period with critical-path P99 latency below 100 ms. This yields a 0.01% error budget for failed requests, upstream write failures, and other events classified as unavailable.

## Architecture

1. Services emit `http_requests_total`, `http_request_duration_seconds_bucket`, and service-specific availability counters with `service`, `route`, and `critical_path` labels.
2. Prometheus records rolling error ratios for 5-minute and 1-hour windows.
3. `SloBurnRateMonitor` provides the shared burn-rate calculation used by tests, synthetic checks, and deployment gates.
4. Alertmanager pages on fast exhaustion at 14.4x burn rate and creates tickets for sustained 6x burn rate.
5. Grafana imports `dashboards/slo-burn-rate-dashboard.json` to show budget, burn rate, critical-path P99 latency, and active alerts.

## Deployment and Canary Analysis

Blue-green deployments must compare the green environment's SLO signals against blue before traffic promotion. During canary analysis, keep green at 5%, 25%, and 50% traffic for at least one fast window each. Abort promotion when any page-level alert fires, when P99 latency exceeds 100 ms, or when error-budget burn is higher than blue by more than 2x.

## Security Review

SLO telemetry must not include user identifiers, wallet addresses, authorization headers, request bodies, or other sensitive payloads. Labels are limited to bounded operational dimensions such as service, route template, status class, environment, and critical-path flag.
