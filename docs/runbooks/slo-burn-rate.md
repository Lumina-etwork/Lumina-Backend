# Runbook: SLO Burn Rate Alert

## Triage

1. Open the Lumina System SLO and Burn Rate dashboard.
2. Identify whether the firing condition is availability burn rate, critical-path P99 latency above 100 ms, or both.
3. Compare green and blue deployment metrics if a deployment or canary is active.
4. Check recent upstream, database, circuit-breaker, and load-balancer health events.

## Mitigation

- Roll back or shift traffic to blue if green has a higher burn rate or latency regression.
- Drain unhealthy backends through load-balancer controls.
- Enable rate limiting for abusive traffic patterns that are causing budget exhaustion.
- Escalate to security review if the spike correlates with anomalous traffic or authorization failures.

## Resolution

Keep the incident open until page-level burn rate clears for one hour, slow-window burn rate is below 6x, and critical-path P99 latency remains below 100 ms for two consecutive fast windows. Record consumed error budget and follow-up actions in the incident review.
