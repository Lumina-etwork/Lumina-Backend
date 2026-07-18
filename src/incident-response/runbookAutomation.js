'use strict';

const DEFAULT_P99_TARGET_MS = 100;

const SEVERITY_TO_URGENCY = Object.freeze({
  SEV1: 'high',
  SEV2: 'high',
  SEV3: 'low',
  SEV4: 'low',
});

function normalizeIncident(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('incident payload is required');
  }

  const service = String(input.service || '').trim();
  const severity = String(input.severity || '').trim().toUpperCase();
  const summary = String(input.summary || '').trim();

  if (!service) throw new TypeError('incident.service is required');
  if (!severity) throw new TypeError('incident.severity is required');
  if (!summary) throw new TypeError('incident.summary is required');
  if (!Object.hasOwn(SEVERITY_TO_URGENCY, severity)) {
    throw new RangeError(`unsupported incident severity: ${severity}`);
  }

  return {
    id: input.id || `${service}:${severity}:${summary}`,
    service,
    severity,
    summary,
    source: input.source || 'lumina-backend',
    details: input.details && typeof input.details === 'object' ? input.details : {},
    dedupeKey: input.dedupeKey || `${service}:${severity}:${summary}`.toLowerCase(),
  };
}

function selectRunbook(incident, runbooks) {
  const normalized = normalizeIncident(incident);
  const candidates = Array.isArray(runbooks) ? runbooks : [];

  return candidates.find((runbook) => {
    const services = runbook.services || ['*'];
    const severities = runbook.severities || ['SEV1', 'SEV2', 'SEV3', 'SEV4'];
    return (services.includes('*') || services.includes(normalized.service))
      && severities.includes(normalized.severity);
  }) || null;
}

function buildPagerDutyEvent(incident, runbook, routingKey) {
  const normalized = normalizeIncident(incident);
  if (!routingKey) throw new TypeError('PagerDuty routing key is required');

  return {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: normalized.dedupeKey,
    payload: {
      summary: normalized.summary,
      source: normalized.source,
      severity: normalized.severity.toLowerCase(),
      component: normalized.service,
      group: 'incident-response',
      class: runbook ? runbook.name : 'unmapped-runbook',
      custom_details: {
        ...normalized.details,
        runbook_url: runbook ? runbook.url : undefined,
        automation_steps: runbook ? runbook.steps : [],
        p99_target_ms: DEFAULT_P99_TARGET_MS,
      },
    },
    client: 'Lumina Runbook Automation',
    client_url: runbook ? runbook.url : undefined,
    links: runbook ? [{ href: runbook.url, text: runbook.name }] : [],
  };
}

function createRunbookAutomation({ pagerDutyClient, routingKey, runbooks, metrics, clock = Date } = {}) {
  if (!pagerDutyClient || typeof pagerDutyClient.trigger !== 'function') {
    throw new TypeError('pagerDutyClient.trigger is required');
  }

  return {
    async handleIncident(incident) {
      const startedAt = clock.now();
      const normalized = normalizeIncident(incident);
      const runbook = selectRunbook(normalized, runbooks);
      const event = buildPagerDutyEvent(normalized, runbook, routingKey);
      const response = await pagerDutyClient.trigger(event);
      const durationMs = clock.now() - startedAt;

      if (metrics) {
        metrics.increment && metrics.increment('incident_runbook_automation_total', {
          service: normalized.service,
          severity: normalized.severity,
          runbook: runbook ? runbook.name : 'unmapped',
        });
        metrics.histogram && metrics.histogram('incident_runbook_automation_duration_ms', durationMs);
      }

      return { incident: normalized, runbook, pagerDuty: response, durationMs };
    },
  };
}

module.exports = {
  DEFAULT_P99_TARGET_MS,
  normalizeIncident,
  selectRunbook,
  buildPagerDutyEvent,
  createRunbookAutomation,
};
