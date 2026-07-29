const { Op, fn, col, literal } = require('sequelize');
const { CapacityMetricSnapshot } = require('../models');

class HistoricalUsageStore {
  async record(entries) {
    const rows = Array.isArray(entries) ? entries : [entries];
    if (rows.length === 0) return 0;
    const sanitized = rows.map((r) => ({
      metric_name: r.metric_name,
      metric_value: r.metric_value,
      labels: r.labels || null,
      snapshot_time: r.snapshot_time || new Date(),
      source: r.source || 'process',
      data_quality: r.data_quality || 'good',
    }));
    const created = await CapacityMetricSnapshot.bulkCreate(sanitized, { validate: true });
    return created.length;
  }

  async query({ metric_name, from, to, source, labels, order = 'ASC', limit = 10000 }) {
    const where = {};
    if (metric_name) where.metric_name = metric_name;
    if (from || to) {
      where.snapshot_time = {};
      if (from) where.snapshot_time[Op.gte] = from;
      if (to) where.snapshot_time[Op.lte] = to;
    }
    if (source) where.source = source;
    if (labels) {
      for (const [key, value] of Object.entries(labels)) {
        where[literal(`labels->>'${key}'`)] = value;
      }
    }
    return CapacityMetricSnapshot.findAll({
      where,
      order: [['snapshot_time', order === 'DESC' ? 'DESC' : 'ASC']],
      limit,
    });
  }

  async listMetrics() {
    const rows = await CapacityMetricSnapshot.findAll({
      attributes: [
        'metric_name',
        [fn('COUNT', col('id')), 'sample_count'],
        [fn('MAX', col('snapshot_time')), 'last_seen'],
        [fn('MIN', col('snapshot_time')), 'first_seen'],
      ],
      group: ['metric_name'],
      order: [[fn('MAX', col('snapshot_time')), 'DESC']],
      raw: true,
    });
    return rows.map((r) => ({
      metric_name: r.metric_name,
      sample_count: parseInt(r.sample_count, 10),
      last_seen: r.last_seen,
      first_seen: r.first_seen,
    }));
  }

  async getLatestValue(metric_name, labels) {
    const where = { metric_name };
    if (labels) {
      for (const [key, value] of Object.entries(labels)) {
        where[literal(`labels->>'${key}'`)] = value;
      }
    }
    const row = await CapacityMetricSnapshot.findOne({
      where,
      order: [['snapshot_time', 'DESC']],
    });
    return row ? row.metric_value : null;
  }

  async getTimeSeries(metric_name, { from, to, source, labels, windowSeconds } = {}) {
    const where = { metric_name };
    if (from || to) {
      where.snapshot_time = {};
      if (from) where.snapshot_time[Op.gte] = from;
      if (to) where.snapshot_time[Op.lte] = to;
    }
    if (source) where.source = source;
    if (labels) {
      for (const [key, value] of Object.entries(labels)) {
        where[literal(`labels->>'${key}'`)] = value;
      }
    }

    if (windowSeconds && windowSeconds > 0) {
      const bucketExpr = literal(`to_timestamp(floor(extract(epoch from snapshot_time) / ${windowSeconds}) * ${windowSeconds})`);
      const rows = await CapacityMetricSnapshot.findAll({
        attributes: [
          [bucketExpr, 'bucket'],
          [fn('AVG', col('metric_value')), 'avg_value'],
          [fn('MAX', col('metric_value')), 'max_value'],
          [fn('MIN', col('metric_value')), 'min_value'],
          [fn('COUNT', col('id')), 'sample_count'],
        ],
        where,
        group: ['bucket'],
        order: [[literal('bucket'), 'ASC']],
        raw: true,
      });
      return rows.map((r) => ({
        snapshot_time: r.bucket,
        avg_value: parseFloat(r.avg_value),
        max_value: parseFloat(r.max_value),
        min_value: parseFloat(r.min_value),
        sample_count: parseInt(r.sample_count, 10),
      }));
    }

    const rows = await CapacityMetricSnapshot.findAll({
      attributes: ['snapshot_time', 'metric_value', 'labels', 'source', 'data_quality'],
      where,
      order: [['snapshot_time', 'ASC']],
      raw: true,
    });
    return rows.map((r) => ({
      snapshot_time: r.snapshot_time,
      metric_value: r.metric_value,
      labels: r.labels,
      source: r.source,
      data_quality: r.data_quality,
    }));
  }

  async getDistinctLabelValues(metric_name, labelKey) {
    const rows = await CapacityMetricSnapshot.findAll({
      attributes: [[literal(`DISTINCT labels->>'${labelKey}'`), 'value']],
      where: { metric_name },
      raw: true,
    });
    return rows.map((r) => r.value).filter(Boolean);
  }

  async prune({ before }) {
    const deleted = await CapacityMetricSnapshot.destroy({
      where: { snapshot_time: { [Op.lt]: before } },
    });
    return deleted;
  }

  async getRetentionStats() {
    const oldest = await CapacityMetricSnapshot.min('snapshot_time');
    const newest = await CapacityMetricSnapshot.max('snapshot_time');
    const count = await CapacityMetricSnapshot.count();
    return { oldest, newest, count };
  }
}

module.exports = HistoricalUsageStore;
