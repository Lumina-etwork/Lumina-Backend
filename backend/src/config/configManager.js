const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { CONFIG_SCHEMA } = require('./schema');

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'config', 'runtime-config.json');

class ConfigurationValidationError extends Error {
  constructor(errors) {
    super(`Configuration validation failed: ${errors.join('; ')}`);
    this.name = 'ConfigurationValidationError';
    this.errors = errors;
  }
}

class ConfigManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.configPath = options.configPath || process.env.RUNTIME_CONFIG_PATH || DEFAULT_CONFIG_PATH;
    this.schema = options.schema || CONFIG_SCHEMA;
    this.reloadDebounceMs = options.reloadDebounceMs || 25;
    this.config = this.applyDefaults({}, this.schema);
    this.version = 0;
    this.watcher = null;
    this.reloadTimer = null;
    this.metrics = options.metrics;
  }

  load() {
    const nextConfig = this.loadFromDisk();
    this.replaceConfig(nextConfig, 'initial-load');
    return this.getAll();
  }

  startWatching() {
    if (this.watcher) return;
    const directory = path.dirname(this.configPath);
    fs.mkdirSync(directory, { recursive: true });
    this.watcher = fs.watch(directory, (eventType, filename) => {
      if (filename && filename !== path.basename(this.configPath)) return;
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => this.reload('fs-watch'), this.reloadDebounceMs);
    });
  }

  stopWatching() {
    clearTimeout(this.reloadTimer);
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }

  reload(source = 'manual') {
    try {
      const nextConfig = this.loadFromDisk();
      this.replaceConfig(nextConfig, source);
      this.recordMetric('success');
      return { ok: true, config: this.getAll() };
    } catch (error) {
      this.recordMetric('failure');
      this.emit('reloadFailed', { source, error, previousConfig: this.getAll(), version: this.version });
      return { ok: false, error };
    }
  }

  get(keyPath, fallback) {
    const value = keyPath.split('.').reduce((valueAtPath, key) => (
      valueAtPath && Object.prototype.hasOwnProperty.call(valueAtPath, key) ? valueAtPath[key] : undefined
    ), this.config);
    return value === undefined ? fallback : value;
  }

  getAll() {
    return JSON.parse(JSON.stringify(this.config));
  }

  loadFromDisk() {
    if (!fs.existsSync(this.configPath)) return this.applyDefaults({}, this.schema);
    const raw = fs.readFileSync(this.configPath, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return this.validate(this.applyDefaults(parsed, this.schema));
  }

  replaceConfig(nextConfig, source) {
    const previousConfig = this.config;
    this.config = Object.freeze(nextConfig);
    this.version += 1;
    this.emit('reloaded', { source, config: this.getAll(), previousConfig, version: this.version });
  }

  applyDefaults(input, schema) {
    const output = { ...input };
    Object.entries(schema).forEach(([section, fields]) => {
      output[section] = { ...(input[section] || {}) };
      Object.entries(fields).forEach(([name, definition]) => {
        if (output[section][name] === undefined) output[section][name] = definition.default;
      });
    });
    return output;
  }

  validate(config) {
    const errors = [];
    Object.entries(this.schema).forEach(([section, fields]) => {
      Object.entries(fields).forEach(([name, definition]) => {
        const value = config[section] && config[section][name];
        const pathName = `${section}.${name}`;
        if (!this.matchesType(value, definition)) errors.push(`${pathName} must be ${definition.type}`);
        if (definition.values && !definition.values.includes(value)) errors.push(`${pathName} must be one of ${definition.values.join(', ')}`);
        if (typeof value === 'number' && definition.min !== undefined && value < definition.min) errors.push(`${pathName} must be >= ${definition.min}`);
        if (typeof value === 'number' && definition.max !== undefined && value > definition.max) errors.push(`${pathName} must be <= ${definition.max}`);
      });
    });
    if (errors.length) throw new ConfigurationValidationError(errors);
    return config;
  }

  matchesType(value, definition) {
    if (definition.type === 'array') return Array.isArray(value);
    if (definition.type === 'enum') return typeof value === 'string';
    return typeof value === definition.type;
  }

  recordMetric(status) {
    if (this.metrics && this.metrics.configReloadsTotal) {
      this.metrics.configReloadsTotal.inc({ status });
    }
  }
}

module.exports = { ConfigManager, ConfigurationValidationError, DEFAULT_CONFIG_PATH };
