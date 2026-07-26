const HistoricalUsageStore = require('../services/historicalUsageStore');
const store = new HistoricalUsageStore();

const capacityMetricsMiddleware = (req, res, next) => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationMs = durationNs / 1e6;
    const now = new Date();
    const route = req.route ? req.route.path : req.path;

    const labels = {
      method: req.method,
      route,
      status_class: `${Math.floor(res.statusCode / 100)}xx`,
    };

    store.record([
      {
        metric_name: 'api_request_duration_ms',
        metric_value: durationMs,
        labels,
        snapshot_time: now,
        source: 'middleware',
      },
      {
        metric_name: 'api_request_size_bytes',
        metric_value: parseInt(req.headers['content-length'] || '0', 10),
        labels,
        snapshot_time: now,
        source: 'middleware',
      },
    ]).catch(() => {});
  });

  next();
};

module.exports = { capacityMetricsMiddleware };
