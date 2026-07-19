const { DataTypes } = require('sequelize');
const { sequelize } = require('../database/connection');

const AdminAuditLog = sequelize.define('AdminAuditLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  admin_pubkey: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Public key of the admin who performed the action',
  },
  action: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Type of action performed (e.g., CREATE_VESTING_SCHEDULE, REVOKE_GRANT, APPROVE_KYC)',
  },
  ip_address: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'IP address from which the action was performed',
  },
  payload: {
    type: DataTypes.JSONB,
    allowNull: false,
    comment: 'The exact payload submitted for the action',
  },
  resource_id: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'ID of the resource affected (e.g., schedule_id, beneficiary_id)',
  },
  timestamp: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    allowNull: false,
  },
  sequence_number: {
    type: DataTypes.BIGINT,
    allowNull: false,
    unique: true,
    comment: 'Monotonic audit sequence used for chain verification',
  },
  previous_hash: {
    type: DataTypes.STRING(64),
    allowNull: false,
    comment: 'SHA-256 hash of the previous audit entry, or genesis hash for the first entry',
  },
  audit_hash: {
    type: DataTypes.STRING(64),
    allowNull: false,
    comment: 'SHA-256 hash over the canonical audit entry payload and previous_hash',
  },
}, {
  tableName: 'admin_audit_logs',
  timestamps: false, // Using timestamp column instead
  indexes: [
    {
      fields: ['admin_pubkey'],
    },
    {
      fields: ['action'],
    },
    {
      fields: ['timestamp'],
    },
    {
      fields: ['resource_id'],
    },
    {
      unique: true,
      fields: ['sequence_number'],
    },
    {
      fields: ['previous_hash'],
    },
    {
      fields: ['audit_hash'],
    },
  ],
});

module.exports = AdminAuditLog;
