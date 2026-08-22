'use strict';

const os = require('os');
const { context, trace } = require('@opentelemetry/api');

const SEVERITY_NUMBER = Object.freeze({
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
});

const DEFAULT_RESOURCE = Object.freeze({
  'service.name': process.env.OTEL_SERVICE_NAME || process.env.npm_package_name || 'vesting-vault-backend',
  'service.version': process.env.npm_package_version || '1.0.0',
  'deployment.environment': process.env.NODE_ENV || 'development',
  'host.name': os.hostname(),
});

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN = /authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|session|set-cookie/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;

  return Object.entries(value).reduce((acc, [key, nestedValue]) => {
    acc[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(nestedValue);
    return acc;
  }, {});
}

function normalizeError(error) {
  if (!error) return undefined;
  return {
    'exception.type': error.name || 'Error',
    'exception.message': error.message || String(error),
    'exception.stacktrace': error.stack,
  };
}

function getActiveTraceFields() {
  const span = trace.getSpan(context.active());
  const spanContext = span && span.spanContext ? span.spanContext() : undefined;

  if (!spanContext || !spanContext.traceId) return {};

  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    trace_flags: spanContext.traceFlags,
  };
}

function formatLogRecord(level, body, attributes = {}, error) {
  const severityText = level.toUpperCase();
  const errorAttributes = normalizeError(error);
  const timestamp = new Date().toISOString();

  return redact({
    timestamp,
    observed_timestamp: timestamp,
    severity_text: severityText,
    severity_number: SEVERITY_NUMBER[level] || SEVERITY_NUMBER.info,
    body,
    resource: DEFAULT_RESOURCE,
    attributes: {
      ...getActiveTraceFields(),
      ...attributes,
      ...(errorAttributes || {}),
    },
  });
}

/**
 * Formats a log record as the legacy plaintext format:
 *   [LEVEL] body {key=value key2=value2 ...}
 *
 * This is used by dual-write mode to emit a human-readable line alongside
 * the structured OTel JSON output.
 */
function formatPlaintext(record) {
  const { severity_text, body, attributes } = record;
  const pairs = Object.entries(attributes || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      const serialised = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `${k}=${serialised}`;
    })
    .join(' ');

  return pairs ? `[${severity_text}] ${body} {${pairs}}` : `[${severity_text}] ${body}`;
}

/**
 * Determines whether dual-write mode is active.
 * Checks the module-level `dualWriteEnabled` flag first (set via
 * `logger.enableDualWrite()` / `logger.disableDualWrite()`), then falls back
 * to the OTEL_DUAL_WRITE environment variable.
 */
let dualWriteEnabled = null; // null = defer to env var

function isDualWriteActive() {
  if (dualWriteEnabled !== null) return dualWriteEnabled;
  return process.env.OTEL_DUAL_WRITE === 'true';
}

function write(level, body, attributes = {}, error) {
  const record = formatLogRecord(level, body, attributes, error);
  const jsonLine = JSON.stringify(record);

  const isError = level === 'error' || level === 'fatal';
  const isWarn = level === 'warn';
  const emit = isError ? console.error : isWarn ? console.warn : console.log;

  // Always emit OTel JSON
  emit(jsonLine);

  // Dual-write: also emit legacy plaintext
  if (isDualWriteActive()) {
    console.log(formatPlaintext(record));
  }

  return record;
}

// ---------------------------------------------------------------------------
// OTel Semantic Convention attribute helpers
// These helpers return well-typed attribute objects that callers can spread
// into the `attributes` argument of any logger call.
// ---------------------------------------------------------------------------

/**
 * Builds messaging span attributes per OTel Messaging semantic conventions.
 * https://opentelemetry.io/docs/specs/semconv/messaging/
 *
 * @param {object} opts
 * @param {string} opts.system       e.g. 'rabbitmq', 'bullmq', 'kafka'
 * @param {string} opts.destination  queue / topic / exchange name
 * @param {string} opts.operation    'publish' | 'receive' | 'process' | 'settle'
 * @param {object} [opts.extra]      any additional attributes to merge
 */
function messagingAttributes({ system, destination, operation, extra = {} }) {
  return {
    'messaging.system': system,
    'messaging.destination': destination,
    'messaging.operation': operation,
    ...extra,
  };
}

/**
 * Builds database span attributes per OTel Database semantic conventions.
 * https://opentelemetry.io/docs/specs/semconv/database/
 *
 * @param {object} opts
 * @param {string} opts.system     e.g. 'postgresql', 'redis'
 * @param {string} [opts.name]     database name
 * @param {string} [opts.operation] SQL verb, e.g. 'SELECT', 'INSERT'
 * @param {string} [opts.statement] sanitised SQL statement
 * @param {object} [opts.extra]    any additional attributes to merge
 */
function dbAttributes({ system, name, operation, statement, extra = {} }) {
  return {
    'db.system': system,
    ...(name !== undefined ? { 'db.name': name } : {}),
    ...(operation !== undefined ? { 'db.operation': operation } : {}),
    ...(statement !== undefined ? { 'db.statement': statement } : {}),
    ...extra,
  };
}

/**
 * Builds RPC span attributes per OTel RPC semantic conventions.
 * https://opentelemetry.io/docs/specs/semconv/rpc/
 *
 * @param {object} opts
 * @param {string} opts.system   e.g. 'grpc', 'jsonrpc', 'stellar_soroban'
 * @param {string} [opts.service] fully-qualified service name
 * @param {string} [opts.method]  method name
 * @param {object} [opts.extra]  any additional attributes to merge
 */
function rpcAttributes({ system, service, method, extra = {} }) {
  return {
    'rpc.system': system,
    ...(service !== undefined ? { 'rpc.service': service } : {}),
    ...(method !== undefined ? { 'rpc.method': method } : {}),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Logger object
// ---------------------------------------------------------------------------

const logger = {
  trace: (body, attributes) => write('trace', body, attributes),
  debug: (body, attributes) => write('debug', body, attributes),
  info: (body, attributes) => write('info', body, attributes),
  warn: (body, attributes) => write('warn', body, attributes),
  error: (body, attributes = {}, error) => write('error', body, attributes, error),
  fatal: (body, attributes = {}, error) => write('fatal', body, attributes, error),

  child(defaultAttributes = {}) {
    return Object.fromEntries(
      ['trace', 'debug', 'info', 'warn'].map((level) => [
        level,
        (body, attributes = {}) => write(level, body, { ...defaultAttributes, ...attributes }),
      ]).concat(
        ['error', 'fatal'].map((level) => [
          level,
          (body, attributes = {}, error) => write(level, body, { ...defaultAttributes, ...attributes }, error),
        ])
      )
    );
  },

  /** Enable dual-write mode programmatically (overrides OTEL_DUAL_WRITE env var). */
  enableDualWrite() {
    dualWriteEnabled = true;
  },

  /** Disable dual-write mode programmatically. */
  disableDualWrite() {
    dualWriteEnabled = false;
  },

  /** Reset dual-write mode back to env-var-controlled behaviour. */
  resetDualWrite() {
    dualWriteEnabled = null;
  },

  // Exposed for testing
  formatLogRecord,
  formatPlaintext,
  redact,

  // Semantic convention helpers
  messagingAttributes,
  dbAttributes,
  rpcAttributes,
};

module.exports = logger;
