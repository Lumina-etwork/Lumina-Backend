'use strict';

const logger = require('../src/utils/structuredLogger');
const { validateLogRecord } = require('../src/utils/validateOtelLogFormat');

// Capture console output without printing during tests
function captureConsole(fn) {
  const lines = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

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

  test('all severity levels map to valid OTel severity_number range', () => {
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    for (const level of levels) {
      const record = logger.formatLogRecord(level, 'test');
      expect(record.severity_number).toBeGreaterThanOrEqual(1);
      expect(record.severity_number).toBeLessThanOrEqual(24);
    }
  });

  test('record includes required resource fields', () => {
    const record = logger.formatLogRecord('info', 'resource check');
    expect(record.resource['service.name']).toBeDefined();
    expect(record.resource['service.version']).toBeDefined();
    expect(record.resource['deployment.environment']).toBeDefined();
    expect(record.resource['host.name']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Dual-write mode
// ---------------------------------------------------------------------------
describe('dual-write mode', () => {
  beforeEach(() => logger.resetDualWrite());
  afterEach(() => logger.resetDualWrite());

  test('does NOT emit plaintext by default', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logger.info('no plaintext expected', {});
      // All calls should be JSON lines
      for (const call of logSpy.mock.calls) {
        const line = call[0];
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  test('emits both OTel JSON and plaintext when enabled programmatically', () => {
    logger.enableDualWrite();

    const lines = captureConsole(() => {
      logger.info('dual write test', { 'custom.field': 'hello' });
    });

    // Expect at least two lines: the JSON and the plaintext
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const jsonLine = lines.find((l) => {
      try { JSON.parse(l); return true; } catch { return false; }
    });
    const plaintextLine = lines.find((l) => l.startsWith('[INFO]'));

    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine);
    expect(parsed.severity_text).toBe('INFO');
    expect(parsed.body).toBe('dual write test');

    expect(plaintextLine).toBeDefined();
    expect(plaintextLine).toContain('[INFO] dual write test');
    expect(plaintextLine).toContain('custom.field=hello');
  });

  test('emits plaintext when OTEL_DUAL_WRITE env var is "true"', () => {
    // Reset programmatic flag so env var is consulted
    logger.resetDualWrite();
    const original = process.env.OTEL_DUAL_WRITE;
    process.env.OTEL_DUAL_WRITE = 'true';

    try {
      const lines = captureConsole(() => {
        logger.warn('env var dual write', { 'x': '1' });
      });

      // Must have a plaintext [WARN] line
      const plaintextLine = lines.find((l) => l.startsWith('[WARN]'));
      expect(plaintextLine).toBeDefined();
      expect(plaintextLine).toContain('env var dual write');
    } finally {
      if (original === undefined) {
        delete process.env.OTEL_DUAL_WRITE;
      } else {
        process.env.OTEL_DUAL_WRITE = original;
      }
    }
  });

  test('disableDualWrite suppresses plaintext even when OTEL_DUAL_WRITE=true', () => {
    logger.disableDualWrite();
    const original = process.env.OTEL_DUAL_WRITE;
    process.env.OTEL_DUAL_WRITE = 'true';

    try {
      const lines = captureConsole(() => {
        logger.info('should be json only', {});
      });

      const plaintextLine = lines.find((l) => l.startsWith('[INFO]'));
      expect(plaintextLine).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.OTEL_DUAL_WRITE;
      } else {
        process.env.OTEL_DUAL_WRITE = original;
      }
    }
  });

  test('formatPlaintext produces expected format', () => {
    const record = logger.formatLogRecord('debug', 'hello world', {
      'db.system': 'postgresql',
      'db.operation': 'SELECT',
    });
    const plain = logger.formatPlaintext(record);
    expect(plain).toMatch(/^\[DEBUG\] hello world \{.+\}$/);
    expect(plain).toContain('db.system=postgresql');
    expect(plain).toContain('db.operation=SELECT');
  });

  test('formatPlaintext omits braces when there are no attributes', () => {
    const record = logger.formatLogRecord('info', 'bare message', {});
    const plain = logger.formatPlaintext(record);
    expect(plain).toBe('[INFO] bare message');
  });
});

// ---------------------------------------------------------------------------
// OTel semantic convention attribute helpers
// ---------------------------------------------------------------------------
describe('semantic convention helpers', () => {
  test('messagingAttributes returns required fields', () => {
    const attrs = logger.messagingAttributes({
      system: 'rabbitmq',
      destination: 'claims.queue',
      operation: 'publish',
    });
    expect(attrs['messaging.system']).toBe('rabbitmq');
    expect(attrs['messaging.destination']).toBe('claims.queue');
    expect(attrs['messaging.operation']).toBe('publish');
  });

  test('messagingAttributes merges extra fields', () => {
    const attrs = logger.messagingAttributes({
      system: 'bullmq',
      destination: 'jobs',
      operation: 'process',
      extra: { 'messaging.message.id': 'abc123' },
    });
    expect(attrs['messaging.message.id']).toBe('abc123');
  });

  test('dbAttributes returns required fields and omits optional undefined ones', () => {
    const attrs = logger.dbAttributes({ system: 'postgresql', name: 'lumina' });
    expect(attrs['db.system']).toBe('postgresql');
    expect(attrs['db.name']).toBe('lumina');
    expect(Object.keys(attrs)).not.toContain('db.operation');
    expect(Object.keys(attrs)).not.toContain('db.statement');
  });

  test('dbAttributes includes optional fields when provided', () => {
    const attrs = logger.dbAttributes({
      system: 'postgresql',
      name: 'lumina',
      operation: 'SELECT',
      statement: 'SELECT * FROM vaults WHERE id = ?',
    });
    expect(attrs['db.operation']).toBe('SELECT');
    expect(attrs['db.statement']).toBe('SELECT * FROM vaults WHERE id = ?');
  });

  test('rpcAttributes returns required fields', () => {
    const attrs = logger.rpcAttributes({
      system: 'stellar_soroban',
      service: 'VestingVault',
      method: 'claim',
    });
    expect(attrs['rpc.system']).toBe('stellar_soroban');
    expect(attrs['rpc.service']).toBe('VestingVault');
    expect(attrs['rpc.method']).toBe('claim');
  });

  test('rpcAttributes omits service and method when not provided', () => {
    const attrs = logger.rpcAttributes({ system: 'grpc' });
    expect(attrs['rpc.system']).toBe('grpc');
    expect(Object.keys(attrs)).not.toContain('rpc.service');
    expect(Object.keys(attrs)).not.toContain('rpc.method');
  });

  test('semantic attributes can be spread into a log call without error', () => {
    const dbAttrs = logger.dbAttributes({ system: 'redis', operation: 'GET' });
    expect(() => {
      logger.formatLogRecord('debug', 'cache lookup', dbAttrs);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CI validation utility
// ---------------------------------------------------------------------------
describe('validateOtelLogFormat', () => {
  test('validates a well-formed log record as valid', () => {
    const record = logger.formatLogRecord('info', 'validation check', {
      'http.request.method': 'GET',
    });
    const { valid, errors } = validateLogRecord(record);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test('rejects a record missing severity_number', () => {
    const record = logger.formatLogRecord('info', 'missing field');
    delete record.severity_number;
    const { valid, errors } = validateLogRecord(record);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('severity_number'))).toBe(true);
  });

  test('rejects a record missing service.name in resource', () => {
    const record = logger.formatLogRecord('warn', 'bad resource');
    delete record.resource['service.name'];
    const { valid, errors } = validateLogRecord(record);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('service.name'))).toBe(true);
  });

  test('rejects severity_number outside 1-24 range', () => {
    const record = logger.formatLogRecord('info', 'out of range');
    record.severity_number = 99;
    const { valid, errors } = validateLogRecord(record);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('outside valid OTel range'))).toBe(true);
  });
});
