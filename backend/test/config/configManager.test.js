const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigManager, ConfigurationValidationError } = require('../../src/config/configManager');

const writeConfig = (dir, value) => {
  const file = path.join(dir, 'runtime-config.json');
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
};

describe('ConfigManager', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-config-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('loads defaults when no runtime config file exists', () => {
    const manager = new ConfigManager({ configPath: path.join(dir, 'missing.json') });

    const config = manager.load();

    expect(config.server.port).toBe(4000);
    expect(config.deployment.strategy).toBe('blue-green');
    expect(config.server.criticalPathP99Ms).toBe(100);
  });

  test('validates schema and rejects invalid hot reloads without replacing active config', () => {
    const configPath = writeConfig(dir, { server: { port: 8080 } });
    const manager = new ConfigManager({ configPath });
    manager.load();

    fs.writeFileSync(configPath, JSON.stringify({ server: { port: 99999 } }));
    const result = manager.reload('test');

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(ConfigurationValidationError);
    expect(manager.get('server.port')).toBe(8080);
  });

  test('hot reloads valid changes and records success metric', () => {
    const configPath = writeConfig(dir, { deployment: { strategy: 'blue-green' } });
    const metrics = { configReloadsTotal: { inc: jest.fn() } };
    const manager = new ConfigManager({ configPath, metrics });
    manager.load();

    fs.writeFileSync(configPath, JSON.stringify({ deployment: { strategy: 'canary', canaryPercent: 10 } }));
    const result = manager.reload('test');

    expect(result.ok).toBe(true);
    expect(manager.get('deployment.strategy')).toBe('canary');
    expect(manager.get('deployment.canaryPercent')).toBe(10);
    expect(metrics.configReloadsTotal.inc).toHaveBeenCalledWith({ status: 'success' });
  });
});
