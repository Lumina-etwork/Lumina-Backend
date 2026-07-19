const crypto = require('crypto');

const ENVELOPE_VERSION = 'lpfe:v1';
const DEFAULT_SENSITIVE_FIELDS = [
  'email',
  'phone',
  'ssn',
  'tax_id',
  'taxId',
  'full_name',
  'fullName',
  'date_of_birth',
  'dateOfBirth',
  'addressLine1',
  'addressLine2',
  'street_address',
  'bank_account',
  'routing_number',
  'wallet_private_key',
  'privateKey',
  'secret',
];

function keyFromEnv() {
  const raw = process.env.PAYLOAD_FIELD_ENCRYPTION_KEY;
  if (!raw) return null;

  const maybeBase64 = Buffer.from(raw, 'base64');
  if (maybeBase64.length === 32 && maybeBase64.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) {
    return maybeBase64;
  }

  if (/^[a-f0-9]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  return crypto.createHash('sha256').update(raw).digest();
}

function normalizeFields(fields) {
  if (Array.isArray(fields)) return new Set(fields.filter(Boolean));
  if (typeof fields === 'string') {
    return new Set(fields.split(',').map((field) => field.trim()).filter(Boolean));
  }
  if (process.env.PAYLOAD_SENSITIVE_FIELDS) {
    return normalizeFields(process.env.PAYLOAD_SENSITIVE_FIELDS);
  }
  return new Set(DEFAULT_SENSITIVE_FIELDS);
}

function isEncryptedEnvelope(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      value.__encrypted === true &&
      value.v === ENVELOPE_VERSION &&
      typeof value.alg === 'string' &&
      typeof value.iv === 'string' &&
      typeof value.tag === 'string' &&
      typeof value.ct === 'string',
  );
}

function encryptValue(value, key, aad = '') {
  if (value === null || value === undefined || isEncryptedEnvelope(value)) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const plaintext = Buffer.from(JSON.stringify(value));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    __encrypted: true,
    v: ENVELOPE_VERSION,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ciphertext.toString('base64'),
  };
}

function decryptValue(value, key, aad = '') {
  if (!isEncryptedEnvelope(value)) return value;

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(value.ct, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

function transformSensitiveFields(input, operation, options = {}) {
  const key = options.key || keyFromEnv();
  if (!key) return input;

  const sensitiveFields = normalizeFields(options.sensitiveFields);
  const seen = new WeakSet();

  function visit(value, path = []) {
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Date) {
      return value;
    }
    if (isEncryptedEnvelope(value)) return operation(value, key, path.join('.'));
    if (seen.has(value)) return value;
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item, index) => visit(item, path.concat(String(index))));
    }

    return Object.entries(value).reduce((acc, [field, fieldValue]) => {
      const fieldPath = path.concat(field);
      acc[field] = sensitiveFields.has(field)
        ? operation(fieldValue, key, fieldPath.join('.'))
        : visit(fieldValue, fieldPath);
      return acc;
    }, {});
  }

  return visit(input);
}

const encryptSensitiveFields = (input, options) => transformSensitiveFields(input, encryptValue, options);
const decryptSensitiveFields = (input, options) => transformSensitiveFields(input, decryptValue, options);

module.exports = {
  DEFAULT_SENSITIVE_FIELDS,
  ENVELOPE_VERSION,
  decryptSensitiveFields,
  decryptValue,
  encryptSensitiveFields,
  encryptValue,
  isEncryptedEnvelope,
  keyFromEnv,
  normalizeFields,
};
