'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('capacity_metric_snapshots', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      metric_name: {
        type: Sequelize.STRING(100),
        allowNull: false,
        comment: 'Metric identifier (e.g. api_throughput_rps, db_pool_usage_pct)',
      },
      metric_value: {
        type: Sequelize.DOUBLE,
        allowNull: false,
        comment: 'Sampled metric value',
      },
      labels: {
        type: Sequelize.JSONB,
        allowNull: true,
        comment: 'Bounded operational dimensions (route, method, queue, type, etc.)',
      },
      snapshot_time: {
        type: Sequelize.DATE,
        allowNull: false,
        comment: 'Timestamp when the metric was sampled',
      },
      source: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'Source of the metric (prometheus, postgres, process)',
      },
      data_quality: {
        type: Sequelize.ENUM('excellent', 'good', 'fair', 'poor'),
        allowNull: false,
        defaultValue: 'good',
        comment: 'Quality rating of the metric data',
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex('capacity_metric_snapshots', ['metric_name', 'snapshot_time'], {
      name: 'idx_capacity_metric_name_time',
    });
    await queryInterface.addIndex('capacity_metric_snapshots', ['snapshot_time'], {
      name: 'idx_capacity_snapshot_time',
    });
    await queryInterface.addIndex('capacity_metric_snapshots', ['metric_name', 'source'], {
      name: 'idx_capacity_metric_name_source',
    });

    await queryInterface.sequelize.query(`
      COMMENT ON TABLE capacity_metric_snapshots IS 'Sampled system metrics for capacity planning and historical usage trending';
      COMMENT ON COLUMN capacity_metric_snapshots.id IS 'Unique identifier for the metric snapshot';
      COMMENT ON COLUMN capacity_metric_snapshots.metric_name IS 'Metric identifier such as api_throughput_rps, db_pool_usage_pct, process_cpu_ratio';
      COMMENT ON COLUMN capacity_metric_snapshots.metric_value IS 'Sampled value of the metric at snapshot_time';
      COMMENT ON COLUMN capacity_metric_snapshots.labels IS 'Bounded operational dimensions as JSON (route template, method, queue name, etc.)';
      COMMENT ON COLUMN capacity_metric_snapshots.snapshot_time IS 'Exact timestamp when the metric was sampled';
      COMMENT ON COLUMN capacity_metric_snapshots.source IS 'Origin system (prometheus, postgres, process)';
      COMMENT ON COLUMN capacity_metric_snapshots.data_quality IS 'Quality rating of the metric data (excellent, good, fair, poor)';
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('capacity_metric_snapshots');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_capacity_metric_snapshots_data_quality"');
  },
};
