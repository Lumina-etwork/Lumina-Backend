const SecretRotationService = require('../services/secretRotationService');

class SecretRotationJob {
  constructor({ service = new SecretRotationService(), intervalMs = Number(process.env.SECRET_ROTATION_SCAN_INTERVAL_MS) || 60000, logger = console } = {}) {
    this.service = service;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.timer = null;
  }

  start() {
    if (process.env.SECRET_ROTATION_ENABLED !== 'true') {
      this.logger.log('Secret rotation job disabled. Set SECRET_ROTATION_ENABLED=true to enable.');
      return false;
    }

    if (this.timer) {
      return true;
    }

    this.timer = setInterval(() => this.runOnce(), this.intervalMs);
    this.timer.unref?.();
    this.runOnce();
    return true;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce() {
    try {
      const results = await this.service.rotateDueSecrets();
      if (results.length > 0) {
        this.logger.log(`Secret rotation completed for ${results.length} secret(s).`);
      }
      return results;
    } catch (error) {
      this.logger.error('Secret rotation run failed:', error);
      throw error;
    }
  }
}

module.exports = SecretRotationJob;
