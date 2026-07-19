const { DataTypes } = require('sequelize');
const { sequelize } = require('../database/connection');

const ScheduledJob = sequelize.define('ScheduledJob', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  type: { type: DataTypes.STRING(128), allowNull: false },
  payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  status: { type: DataTypes.ENUM('queued', 'leased', 'completed', 'failed'), allowNull: false, defaultValue: 'queued' },
  priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  runAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  workerId: { type: DataTypes.STRING(128), allowNull: true },
  leaseToken: { type: DataTypes.UUID, allowNull: true },
  leasedAt: { type: DataTypes.DATE, allowNull: true },
  leaseExpiresAt: { type: DataTypes.DATE, allowNull: true },
  attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  maxAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
  lastError: { type: DataTypes.TEXT, allowNull: true },
  result: { type: DataTypes.JSONB, allowNull: true },
  completedAt: { type: DataTypes.DATE, allowNull: true },
  idempotencyKey: { type: DataTypes.STRING(256), allowNull: true, unique: true },
}, {
  tableName: 'scheduled_jobs',
  indexes: [
    { fields: ['status', 'runAt', 'priority'] },
    { fields: ['leaseExpiresAt'] },
    { unique: true, fields: ['idempotencyKey'], where: { idempotencyKey: { [require('sequelize').Op.ne]: null } } },
  ],
});

module.exports = ScheduledJob;
