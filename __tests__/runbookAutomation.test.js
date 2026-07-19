const {
  normalizeIncident,
  selectRunbook,
  buildPagerDutyEvent,
  createRunbookAutomation,
} = require('../src/incident-response/runbookAutomation');

const runbooks = [
  {
    name: 'API SEV1 Runbook',
    url: 'https://runbooks.lumina.local/api-sev1',
    services: ['api'],
    severities: ['SEV1'],
    steps: ['page-on-call', 'enable-read-only-mode', 'start-canary-analysis'],
  },
  {
    name: 'Fallback Runbook',
    url: 'https://runbooks.lumina.local/fallback',
    services: ['*'],
    steps: ['triage', 'escalate'],
  },
];

describe('runbookAutomation', () => {
  it('normalizes incidents and rejects unsupported severities', () => {
    expect(normalizeIncident({ service: ' api ', severity: 'sev1', summary: ' latency ' }))
      .toMatchObject({ service: 'api', severity: 'SEV1', summary: 'latency' });
    expect(() => normalizeIncident({ service: 'api', severity: 'sev9', summary: 'bad' })).toThrow(RangeError);
  });

  it('selects the most specific matching runbook', () => {
    expect(selectRunbook({ service: 'api', severity: 'SEV1', summary: 'down' }, runbooks).name)
      .toBe('API SEV1 Runbook');
    expect(selectRunbook({ service: 'worker', severity: 'SEV3', summary: 'lag' }, runbooks).name)
      .toBe('Fallback Runbook');
  });

  it('builds a PagerDuty Events API v2 trigger payload', () => {
    const event = buildPagerDutyEvent(
      { service: 'api', severity: 'SEV1', summary: 'P99 breach', details: { p99: 180 } },
      runbooks[0],
      'routing-key',
    );

    expect(event).toMatchObject({
      routing_key: 'routing-key',
      event_action: 'trigger',
      payload: {
        summary: 'P99 breach',
        severity: 'sev1',
        custom_details: { p99: 180, p99_target_ms: 100 },
      },
    });
    expect(event.links[0].href).toBe(runbooks[0].url);
  });

  it('triggers PagerDuty and emits automation metrics', async () => {
    const trigger = jest.fn().mockResolvedValue({ status: 'success', dedup_key: 'api:sev1:p99 breach' });
    const metrics = { increment: jest.fn(), histogram: jest.fn() };
    let now = 1000;
    const automation = createRunbookAutomation({
      pagerDutyClient: { trigger },
      routingKey: 'routing-key',
      runbooks,
      metrics,
      clock: { now: () => { now += 12; return now; } },
    });

    const result = await automation.handleIncident({ service: 'api', severity: 'SEV1', summary: 'P99 breach' });

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(result.runbook.name).toBe('API SEV1 Runbook');
    expect(metrics.increment).toHaveBeenCalledWith('incident_runbook_automation_total', expect.objectContaining({ service: 'api' }));
    expect(metrics.histogram).toHaveBeenCalledWith('incident_runbook_automation_duration_ms', 12);
  });
});
