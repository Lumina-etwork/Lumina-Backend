# Capacity Planning and Historical Usage Trending

## Overview

The capacity trending subsystem collects, stores, and analyzes system resource usage over time to enable capacity planning, trend analysis, and proactive exhaustion alerting. It integrates with the existing Prometheus / Grafana monitoring stack and blue-green deployment pipeline.

## Architecture

```
┌─────────────────────┐    ┌──────────────────────────────┐
│ CapacityMetrics     │    │ capacity_metric_snapshots    │
│ Collector (60s)     │───▶│ (PostgreSQL)                 │
│ ─ poll prom-client   │    └─────────────────────────────┘
│ ─ process metrics   │                   │
│ ─ DB pool metrics   │                   ▼
└─────────────────────┘    ┌──────────────────────────────┐
                           │ HistoricalUsageStore         │
                           │ ─ record/query               │
                           │ ─ getTimeSeries              │
                           │ ─ getLatestValue             │
                           │ ─ prune (retention)          │
                           └──────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────┐    ┌──────────────────────────────┐
│ trendCalculator     │◀───│ CapacityProjectionService    │
│ ─ SMA / EMA         │    │ ─ getTrendSummary            │
│ ─ Linear Regression │    │ ─ project                    │
│ ─ Growth Rate       │    │ ─ daysUntilExhaustion        │
│ ─ Seasonal Decomp   │    │ ─ getAlertState              │
│ ─ Anomaly Detection │    └──────────────────────────────┘
└─────────────────────┘                   │
                                          ▼
                           ┌──────────────────────────────┐
                           │ Prometheus Gauges            │
                           │ + Alertmanager Rules         │
                           │ + Grafana Dashboard          │
                           └──────────────────────────────┘
```

## Components

### 1. Data Collection (`capacityMetricsCollector.js`)

A background service running every 60 seconds that:

- Reads all registered `prom-client` gauges/histograms/counters and snapshots their values
- Reads Node.js process metrics (`process.cpuUsage()`, `process.memoryUsage()`, `process.uptime()`)
- Reads PostgreSQL connection pool metrics (`pool.size`, `pool.idle`, `pool.waiting`)
- Writes all snapshots to the `capacity_metric_snapshots` table via `HistoricalUsageStore`

### 2. Historical Storage (`historicalUsageStore.js`)

Database access layer for `capacity_metric_snapshots`:

- `record(entries)` — Bulk insert with validation
- `query({ metric_name, from, to, source, labels })` — Filtered queries
- `listMetrics()` — Aggregated metric catalog (name, count, first/last seen)
- `getTimeSeries(metric_name, { from, to, source, labels, windowSeconds })` — Time-bucketed aggregation
- `getLatestValue(metric_name, labels)` — Most recent value
- `prune({ before })` — Retention enforcement
- `getRetentionStats()` — Data age and volume statistics

### 3. Trend Calculator (`trendCalculator.js`)

Pure mathematical functions with no side effects:

- **SMA**: Simple Moving Average over N periods
- **EMA**: Exponential Moving Average with configurable alpha
- **Linear Regression**: OLS regression returning slope, intercept, R², residuals, confidence intervals, and prediction
- **Growth Rate**: Compound Annual Growth Rate (CAGR)
- **Seasonal Decomposition**: Additive decomposition into trend + seasonal + residual
- **Anomaly Detection**: Points exceeding N standard deviations from model
- **Time-Series Projection**: Linear projection with confidence bands and exhaustion date calculator

### 4. Projection Service (`capacityProjectionService.js`)

Orchestrates trend analysis into actionable outputs:

- `getTrendSummary(metricName)` — 7d, 30d, 90d windows with growth rate, slope, R², projected values, anomaly count
- `project(metricName, { daysAhead })` — Full projection with confidence intervals
- `daysUntilExhaustion(metricName, capacityLimit)` — When a resource will hit a hard limit
- `getAlertState(metricName, { warningThreshold, criticalThreshold, capacityLimit })` — Current alert level

### 5. Middleware & API

- `capacityMetrics.middleware.js` — Per-request duration and size recording
- `capacityRoutes.js` — REST API secured with JWT auth (report endpoint requires admin)

### 6. Prometheus Integration

- Custom gauges registered in `metricsService.js` for capacity signals
- Alerting rules in `monitoring/prometheus/capacity-trending-rules.yaml`
- Grafana dashboard in `monitoring/dashboards/capacity-trending.json`

### 7. Blue-Green Integration

The blue-green controller compares capacity signals between deployments before traffic promotion. See `docs/runbooks/capacity-exhaustion.md`.

## Metric Catalog

| Metric Name | Source | Retention |
|---|---|---|
| `api_throughput_rps` | prometheus middleware | 7d raw, 30d 5m, 1y 1h |
| `api_error_rate_pct` | prometheus middleware | 7d raw, 30d 5m, 1y 1h |
| `api_p99_latency_ms` | prometheus middleware | 7d raw, 30d 5m, 1y 1h |
| `active_db_connections` | postgres pool | 7d raw, 30d 5m, 1y 1h |
| `db_pool_usage_pct` | postgres pool | 7d raw, 30d 5m, 1y 1h |
| `redis_memory_used_bytes` | redis info | 7d raw, 30d 5m |
| `bullmq_queue_depth` | bullmq | 7d raw, 30d 5m |
| `dlq_depth` | dlq service | 7d raw, 30d 5m |
| `process_cpu_usage_ratio` | process | 7d raw, 30d 5m |
| `process_memory_rss_bytes` | process | 7d raw, 30d 5m |
| `event_loop_lag_ms` | process | 7d raw, 30d 5m |

## Performance Targets

- Critical path P99 < 100ms (aligns with system SLO)
- Metric collection completes in < 5s per cycle
- API queries return in < 500ms for windowed data, < 2s for raw data

## Security

- Metric labels are bounded operational dimensions (route template, method, status class)
- No PII, wallet addresses, or authentication tokens in labels
- Report API requires admin authentication
- Prometheus scrape endpoint unchanged

## Retention

- Raw 60s snapshots: 7 days
- 5-minute aggregated: 30 days
- 1-hour aggregated: 1 year
- Pruning runs daily via a scheduled job
