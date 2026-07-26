# Structured logging

Lumina emits newline-delimited JSON logs that follow the OpenTelemetry log data model and semantic convention attribute names. The logger enriches every record with service resource metadata, severity text/number, timestamps, active trace context, and domain attributes supplied by callers.

## Architecture

- `backend/src/utils/structuredLogger.js` owns log record formatting, severity mapping, trace correlation, and recursive redaction of secrets.
- `backend/src/middleware/structuredLogging.middleware.js` emits one completion log for every HTTP request after the tracing middleware has attached the request trace context.
- Logs are written to stdout/stderr for container collection by Kubernetes, OpenTelemetry Collector, or existing log aggregation agents.

## Operational guidance

Dashboards and alerts should group by `service.name`, `deployment.environment`, `http.response.status_code`, and `url.path`. Critical path latency can be derived from `event.duration`, which is stored in nanoseconds per OpenTelemetry conventions.

During blue-green or canary deployments, compare error-rate and P99 latency queries for the blue and green workloads before shifting traffic. Roll back if the canary shows sustained 5xx growth, missing logs, or P99 request duration above 100ms on critical paths.

## Security

Sensitive keys such as authorization headers, cookies, passwords, tokens, API keys, and private keys are replaced with `[REDACTED]` before a record is serialized.
