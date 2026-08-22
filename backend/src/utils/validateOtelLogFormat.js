'use strict';

/**
 * validateOtelLogFormat.js
 *
 * CI utility that validates a structuredLogger log record against the
 * required OpenTelemetry Log Data Model fields and the OTel semantic
 * conventions used in this project.
 *
 * Usage (standalone):
 *   node backend/src/utils/validateOtelLogFormat.js
 *
 * Exit codes:
 *   0  All required fields present and well-typed
 *   1  One or more validation errors detected
 */

const logger = require('./structuredLogger');

// ---------------------------------------------------------------------------
// Required top-level OTel Log Data Model fields
// https://opentelemetry.io/docs/specs/otel/logs/data-model/
// ---------------------------------------------------------------------------
const REQUIRED_TOP_LEVEL = [
  { field: 'timestamp', type: 'string' },
  { field: 'observed_timestamp', type: 'string' },
  { field: 'severity_text', type: 'string' },
  { field: 'severity_number', type: 'number' },
  { field: 'body', type: 'string' },
  { field: 'resource', type: 'object' },
  { field: 'attributes', type: 'object' },
];

// Required resource fields
const REQUIRED_RESOURCE = [
  { field: 'service.name', type: 'string' },
  { field: 'service.version', type: 'string' },
  { field: 'deployment.environment', type: 'string' },
  { field: 'host.name', type: 'string' },
];

// Severity number must be within the OTel range 1-24
const SEVERITY_RANGE = { min: 1, max: 24 };

// Known severity text → number mappings
const KNOWN_SEVERITY_MAP = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validates a single log record object.
 *
 * @param {object} record - The log record to validate.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateLogRecord(record) {
  const errors = [];

  // Top-level fields
  for (const { field, type } of REQUIRED_TOP_LEVEL) {
    if (record[field] === undefined || record[field] === null) {
      errors.push(`Missing required top-level field: ${field}`);
    } else if (typeof record[field] !== type) {
      errors.push(`Field "${field}" expected type "${type}", got "${typeof record[field]}"`);
    }
  }

  // Resource fields
  if (record.resource && typeof record.resource === 'object') {
    for (const { field, type } of REQUIRED_RESOURCE) {
      if (record.resource[field] === undefined || record.resource[field] === null) {
        errors.push(`Missing required resource field: resource.${field}`);
      } else if (typeof record.resource[field] !== type) {
        errors.push(`Resource field "${field}" expected type "${type}", got "${typeof record.resource[field]}"`);
      }
    }
  }

  // severity_number range check
  if (typeof record.severity_number === 'number') {
    if (record.severity_number < SEVERITY_RANGE.min || record.severity_number > SEVERITY_RANGE.max) {
      errors.push(
        `severity_number ${record.severity_number} is outside valid OTel range [${SEVERITY_RANGE.min}, ${SEVERITY_RANGE.max}]`
      );
    }

    // Consistency check: severity_text must match expected number
    const expectedNumber = KNOWN_SEVERITY_MAP[record.severity_text];
    if (expectedNumber !== undefined && record.severity_number !== expectedNumber) {
      errors.push(
        `severity_number ${record.severity_number} does not match severity_text "${record.severity_text}" (expected ${expectedNumber})`
      );
    }
  }

  // timestamp must be a valid ISO 8601 string
  if (typeof record.timestamp === 'string' && isNaN(Date.parse(record.timestamp))) {
    errors.push(`timestamp "${record.timestamp}" is not a valid ISO 8601 datetime`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Runs validation against a sample record produced by the logger and
 * prints results. Exits with code 1 if validation fails.
 */
function runCiValidation() {
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  let totalErrors = 0;

  console.log('=== OTel Log Format Validation ===\n');

  for (const level of levels) {
    const record = logger.formatLogRecord(level, `CI validation sample – ${level}`, {
      'http.request.method': 'GET',
      'url.path': '/health',
    });

    const { valid, errors } = validateLogRecord(record);

    if (valid) {
      console.log(`  ✓ [${level.toUpperCase().padEnd(5)}] OK`);
    } else {
      console.error(`  ✗ [${level.toUpperCase().padEnd(5)}] FAILED:`);
      for (const err of errors) {
        console.error(`      - ${err}`);
      }
      totalErrors += errors.length;
    }
  }

  console.log('');

  if (totalErrors > 0) {
    console.error(`Validation FAILED with ${totalErrors} error(s).\n`);
    process.exitCode = 1;
  } else {
    console.log('All log records passed OTel format validation.\n');
  }
}

// Run when executed directly
if (require.main === module) {
  runCiValidation();
}

module.exports = { validateLogRecord, runCiValidation };
