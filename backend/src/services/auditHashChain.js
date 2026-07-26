const crypto = require('crypto');

const HASH_ALGORITHM = 'sha256';
const GENESIS_HASH = '0'.repeat(64);

const canonicalize = (value) => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
};

const stableStringify = (value) => JSON.stringify(canonicalize(value));

const buildHashPayload = ({
  id,
  admin_pubkey,
  action,
  ip_address,
  payload,
  resource_id,
  timestamp,
  previous_hash,
}) => stableStringify({
  id,
  admin_pubkey,
  action,
  ip_address,
  payload,
  resource_id: resource_id || null,
  timestamp: timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString(),
  previous_hash,
});

const computeAuditHash = (entry) => crypto
  .createHash(HASH_ALGORITHM)
  .update(buildHashPayload(entry))
  .digest('hex');

module.exports = {
  HASH_ALGORITHM,
  GENESIS_HASH,
  stableStringify,
  buildHashPayload,
  computeAuditHash,
};
