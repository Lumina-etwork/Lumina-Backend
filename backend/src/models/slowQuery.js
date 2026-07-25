const { DataTypes } = require('sequelize');
const { sequelize } = require('../database/connection');

const SlowQuery = sequelize.define('SlowQuery', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  normalized_query: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  raw_query: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  query_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
  },
  table_name: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  application_name: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  call_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  mean_time_ms: {
    type: DataTypes.DOUBLE,
    allowNull: false,
    defaultValue: 0,
  },
  total_time_ms: {
    type: DataTypes.DOUBLE,
    allowNull: false,
    defaultValue: 0,
  },
  stddev_time_ms: {
    type: DataTypes.DOUBLE,
    allowNull: false,
    defaultValue: 0,
  },
  min_time_ms: {
    type: DataTypes.DOUBLE,
    allowNull: false,
    defaultValue: 0,
  },
  max_time_ms: {
    type: DataTypes.DOUBLE,
    allowNull: false,
    defaultValue: 0,
  },
  last_seen: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  first_seen: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  plan_data: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
}, {
  tableName: 'slow_queries',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      fields: ['normalized_query'],
      unique: true,
    },
    {
      fields: ['query_type'],
    },
    {
      fields: ['table_name'],
    },
    {
      fields: ['mean_time_ms'],
    },
    {
      fields: ['last_seen'],
    },
    {
      fields: ['application_name'],
    },
  ],
});

module.exports = SlowQuery;
