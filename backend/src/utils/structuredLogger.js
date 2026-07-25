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

function write(level, body, attributes = {}, error) {
  const record = formatLogRecord(level, body, attributes, error);
  const line = JSON.stringify(record);

  if (level === 'error' || level === 'fatal') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }

  return record;
}

const logger = {
  trace: (body, attributes) => write('trace', body, attributes),
  debug: (body, attributes) => write('debug', body, attributes),
  info: (body, attributes) => write('info', body, attributes),
  warn: (body, attributes) => write('warn', body, attributes),
  error: (body, attributes = {}, error) => write('error', body, attributes, error),
  fatal: (body, attributes = {}, error) => write('fatal', body, attributes, error),
  child(defaultAttributes = {}) {
    return Object.fromEntries(['trace', 'debug', 'info', 'warn'].map((level) => [
      level,
      (body, attributes = {}) => write(level, body, { ...defaultAttributes, ...attributes }),
    ]).concat(['error', 'fatal'].map((level) => [
      level,
      (body, attributes = {}, error) => write(level, body, { ...defaultAttributes, ...attributes }, error),
    ])));
  },
  formatLogRecord,
  redact,
};

module.exports = logger;
