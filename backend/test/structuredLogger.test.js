'use strict';

const logger = require('../src/utils/structuredLogger');

describe('structuredLogger', () => {
  test('formats OpenTelemetry-compatible log records', () => {
    const record = logger.formatLogRecord('info', 'payment accepted', {
      'http.request.method': 'POST',
      'service.namespace': 'claims',
    });

    expect(record).toMatchObject({
      severity_text: 'INFO',
      severity_number: 9,
      body: 'payment accepted',
    });
    expect(record.resource['service.name']).toBeDefined();
    expect(record.attributes['http.request.method']).toBe('POST');
  });

  test('redacts sensitive nested attributes', () => {
    const record = logger.formatLogRecord('warn', 'auth attempted', {
      authorization: 'Bearer secret',
      nested: { apiKey: 'abc', safe: 'ok' },
    });

    expect(record.attributes.authorization).toBe('[REDACTED]');
    expect(record.attributes.nested.apiKey).toBe('[REDACTED]');
    expect(record.attributes.nested.safe).toBe('ok');
  });

  test('adds exception semantic convention fields', () => {
    const error = new TypeError('bad value');
    const record = logger.formatLogRecord('error', 'failed', {}, error);

    expect(record.attributes['exception.type']).toBe('TypeError');
    expect(record.attributes['exception.message']).toBe('bad value');
    expect(record.attributes['exception.stacktrace']).toContain('TypeError');
  });
});
