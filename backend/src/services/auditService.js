const { Op } = require('sequelize');
const { AdminAuditLog } = require('../models');
const metricsService = require('./metricsService');
const { GENESIS_HASH, computeAuditHash } = require('./auditHashChain');

class AuditService {
  /**
   * Log an administrative action with a tamper-evident SHA-256 hash chain.
   * @param {Object} params - Audit log parameters
   * @param {string} params.adminPubkey - Admin public key
   * @param {string} params.action - Action type (e.g., 'CREATE_VESTING_SCHEDULE')
   * @param {string} params.ipAddress - Requesting IP address
   * @param {Object} params.payload - Data submitted
   * @param {string} [params.resourceId] - ID of affected resource
   */
  static async logAction({ adminPubkey, action, ipAddress, payload, resourceId }) {
    const timestamp = new Date();

    try {
      const previousLog = await AdminAuditLog.findOne({
        order: [['sequence_number', 'DESC'], ['timestamp', 'DESC'], ['id', 'DESC']],
        attributes: ['audit_hash', 'sequence_number'],
      });

      const sequenceNumber = previousLog ? Number(previousLog.sequence_number || 0) + 1 : 1;
      const previousHash = previousLog?.audit_hash || GENESIS_HASH;

      const draft = AdminAuditLog.build({
        admin_pubkey: adminPubkey,
        action,
        ip_address: ipAddress,
        payload,
        resource_id: resourceId,
        timestamp,
        sequence_number: sequenceNumber,
        previous_hash: previousHash,
      });

      draft.audit_hash = computeAuditHash(draft.toJSON());
      const auditLog = await draft.save();
      metricsService.auditEventsTotal?.inc({ action, result: 'success' });
      console.log(`[AuditLog] ${action} by ${adminPubkey} logged at sequence ${sequenceNumber}.`);
      return auditLog;
    } catch (error) {
      metricsService.auditEventsTotal?.inc({ action, result: 'error' });
      console.error(`[AuditLog] Failed to log action ${action}:`, error);
      // We don't want to fail the main action if audit logging fails,
      // but in a production security context, alerting should page the security team.
      return null;
    }
  }

  /**
   * Verify the audit trail hash chain over an optional time window.
   * @param {Object} [options]
   * @param {string|Date} [options.from] - Inclusive lower timestamp bound.
   * @param {string|Date} [options.to] - Inclusive upper timestamp bound.
   * @param {number|string} [options.limit=10000] - Maximum entries to verify.
   * @returns {Promise<Object>} Verification result with first mismatch detail.
   */
  static async verifyHashChain({ from, to, limit = 10000 } = {}) {
    const where = {};
    if (from || to) {
      where.timestamp = {};
      if (from) where.timestamp[Op.gte] = new Date(from);
      if (to) where.timestamp[Op.lte] = new Date(to);
    }

    const parsedLimit = Math.min(Math.max(Number(limit) || 10000, 1), 50000);
    const logs = await AdminAuditLog.findAll({
      where,
      order: [['sequence_number', 'ASC'], ['timestamp', 'ASC'], ['id', 'ASC']],
      limit: parsedLimit,
    });

    const firstLog = logs[0];
    const initialEntry = firstLog?.toJSON ? firstLog.toJSON() : firstLog;
    let expectedPreviousHash = initialEntry?.previous_hash || GENESIS_HASH;
    const mismatches = [];

    for (const log of logs) {
      const entry = log.toJSON ? log.toJSON() : log;
      if (entry.previous_hash !== expectedPreviousHash) {
        mismatches.push({
          id: entry.id,
          sequence_number: entry.sequence_number,
          field: 'previous_hash',
          expected: expectedPreviousHash,
          actual: entry.previous_hash,
        });
        break;
      }

      const expectedHash = computeAuditHash(entry);
      if (entry.audit_hash !== expectedHash) {
        mismatches.push({
          id: entry.id,
          sequence_number: entry.sequence_number,
          field: 'audit_hash',
          expected: expectedHash,
          actual: entry.audit_hash,
        });
        break;
      }

      expectedPreviousHash = entry.audit_hash;
    }

    const valid = mismatches.length === 0;
    metricsService.auditVerificationTotal?.inc({ result: valid ? 'valid' : 'invalid' });
    metricsService.auditHashChainVerifiedEntries?.set(logs.length);

    const firstEntry = initialEntry;
    const lastLog = logs[logs.length - 1];
    const lastEntry = lastLog?.toJSON ? lastLog.toJSON() : lastLog;

    return {
      valid,
      checked: logs.length,
      first_sequence: firstEntry?.sequence_number || null,
      last_sequence: lastEntry?.sequence_number || null,
      head_hash: lastEntry?.audit_hash || null,
      mismatches,
    };
  }

  // Pre-defined action constants
  static ACTIONS = {
    CREATE_VESTING_SCHEDULE: 'CREATE_VESTING_SCHEDULE',
    REVOKE_GRANT: 'REVOKE_GRANT',
    APPROVE_KYC: 'APPROVE_KYC',
    REJECT_KYC: 'REJECT_KYC',
    UPDATE_VAULT_CONFIG: 'UPDATE_VAULT_CONFIG',
    MANUAL_VESTING_TRIGGER: 'MANUAL_VESTING_TRIGGER'
  };
}

module.exports = AuditService;
