const { DataTypes } = require('sequelize');
const { sequelize } = require('../database/connection');

const SlowQueryAlert = sequelize.define('SlowQueryAlert', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  slow_query_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'slow_queries',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  },
  severity: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: {
      isIn: [['warning', 'critical', 'emergency']],
    },
  },
  threshold_ms: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  actual_mean_time_ms: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  fire_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  first_fired_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  last_fired_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  acknowledged: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  acknowledged_by: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  acknowledged_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  pagerduty_incident_id: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
}, {
  tableName: 'slow_query_alerts',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      fields: ['slow_query_id'],
    },
    {
      fields: ['severity'],
    },
    {
      fields: ['last_fired_at'],
    },
    {
      fields: ['acknowledged'],
    },
  ],
});

SlowQueryAlert.associate = function(models) {
  SlowQueryAlert.belongsTo(models.SlowQuery, {
    foreignKey: 'slow_query_id',
    as: 'slowQuery',
  });
};

module.exports = SlowQueryAlert;
