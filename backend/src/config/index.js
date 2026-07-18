const { ConfigManager } = require('./configManager');
const metricsService = require('../services/metricsService');

const configManager = new ConfigManager({ metrics: metricsService });

module.exports = { configManager, ConfigManager };
