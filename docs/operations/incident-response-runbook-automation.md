# Incident Response Runbook Automation with PagerDuty Integration

## Architecture

Lumina incident response automation receives normalized incident signals from services, maps each incident to the most specific runbook, and sends a PagerDuty Events API v2 trigger. The core logic is intentionally synchronous and dependency-light so the critical path remains under the 100 ms P99 target before network I/O.

```text
Service alert -> normalize incident -> select runbook -> emit metrics -> PagerDuty trigger
                                      -> attach runbook URL and automation steps
```

## PagerDuty Integration

Configure the automation with a PagerDuty routing key stored in the deployment secret manager. The event payload includes:

- `dedup_key` for alert coalescing.
- `payload.component` for the Lumina service name.
- `payload.custom_details.runbook_url` for operator hand-off.
- `payload.custom_details.automation_steps` for deterministic first actions.

## Monitoring and Alerting

The automation emits these metrics:

- `incident_runbook_automation_total{service,severity,runbook}`: counter for routed incidents.
- `incident_runbook_automation_duration_ms`: latency histogram for the local automation path.

Recommended alerts:

- Page platform on-call when P99 automation latency is above 100 ms for 5 minutes.
- Page platform on-call when PagerDuty trigger failures exceed 1% over 10 minutes.
- Open a SEV2 when incidents route to the `unmapped` runbook more than three times in 30 minutes.

## Deployment Strategy

1. Deploy the automation disabled in the green environment.
2. Run smoke tests against synthetic SEV1 and SEV3 incidents.
3. Enable a 5% canary of production alerts and compare PagerDuty deduplication and latency metrics.
4. Promote green to blue after 30 minutes with no trigger failures, no unmapped SEV1 incidents, and P99 below 100 ms.
5. Roll back by disabling the automation flag and routing alerts through the existing manual escalation policy.

## Security Review Checklist

- PagerDuty routing keys are read from secrets only and are never logged.
- Incident details are scrubbed before calling automation if they may contain PII.
- Runbook URLs must use HTTPS and point to approved Lumina documentation systems.
- PagerDuty client calls must use TLS certificate validation and bounded timeouts.
