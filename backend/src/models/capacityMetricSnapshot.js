const { DataTypes } = require('sequelize');
const { sequelize } = require('../database/connection');

const CapacityMetricSnapshot = sequelize.define('CapacityMetricSnapshot', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  metric_name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  metric_value: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  labels: {
    type: DataTypes.JSON,
    allowNull: true,
  },
  snapshot_time: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  source: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  data_quality: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'good',
    validate: {
      isIn: [['excellent', 'good', 'fair', 'poor']],
    },
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'capacity_metric_snapshots',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  indexes: [
    {
      fields: ['metric_name', 'snapshot_time'],
    },
    {
      fields: ['snapshot_time'],
    },
    {
      fields: ['metric_name', 'source'],
    },
  ],
});

module.exports = CapacityMetricSnapshot;
