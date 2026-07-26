const CONFIG_SCHEMA = {
  server: {
    port: { type: 'number', default: 4000, min: 1, max: 65535 },
    criticalPathP99Ms: { type: 'number', default: 100, min: 1 },
  },
  security: {
    strictCors: { type: 'boolean', default: true },
    allowedOrigins: { type: 'array', default: [] },
  },
  observability: {
    metricsEnabled: { type: 'boolean', default: true },
    configReloadAlertThreshold: { type: 'number', default: 3, min: 1 },
  },
  deployment: {
    strategy: { type: 'enum', values: ['blue-green', 'rolling', 'canary'], default: 'blue-green' },
    canaryPercent: { type: 'number', default: 5, min: 0, max: 100 },
  },
};

module.exports = { CONFIG_SCHEMA };
