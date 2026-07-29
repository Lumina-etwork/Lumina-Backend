const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMigrations, migrate, rollback, splitSqlSections } = require('../src/database/migrationManager');

class FakeClient {
  constructor() { this.queries = []; this.rows = []; }
  async query(sql, params) {
    this.queries.push({ sql, params });
    if (/SELECT version, checksum/.test(sql)) return { rows: this.rows };
    if (/INSERT INTO/.test(sql)) this.rows.push({ version: params[0], checksum: params[2] });
    if (/^UPDATE/.test(sql)) this.rows = this.rows.filter((row) => row.version !== params[0]);
    return { rows: [] };
  }
}

describe('migrationManager', () => {
  let dir;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('loads versioned migrations in deterministic order', () => {
    fs.writeFileSync(path.join(dir, '002_second.sql'), 'SELECT 2;');
    fs.writeFileSync(path.join(dir, '001_first.sql'), 'SELECT 1;');

    expect(loadMigrations(dir).map((migration) => migration.version)).toEqual(['001', '002']);
  });

  test('splits SQL into up and down sections', () => {
    expect(splitSqlSections('-- +migrate Up\nCREATE TABLE demo(id int);\n-- +migrate Down\nDROP TABLE demo;')).toEqual({
      upSql: 'CREATE TABLE demo(id int);',
      downSql: 'DROP TABLE demo;',
    });
  });

  test('applies only pending migrations and records metadata', async () => {
    fs.writeFileSync(path.join(dir, '001_create_demo.sql'), '-- +migrate Up\nCREATE TABLE demo(id int);\n-- +migrate Down\nDROP TABLE demo;');
    const client = new FakeClient();

    await expect(migrate({ client, migrationsDir: dir })).resolves.toEqual([{ version: '001', name: 'create_demo' }]);

    expect(client.queries.some((query) => query.sql.includes('CREATE TABLE demo'))).toBe(true);
    expect(client.queries.some((query) => query.sql.includes('INSERT INTO'))).toBe(true);
  });

  test('rolls back the latest applied migration', async () => {
    fs.writeFileSync(path.join(dir, '001_create_demo.sql'), '-- +migrate Up\nCREATE TABLE demo(id int);\n-- +migrate Down\nDROP TABLE demo;');
    const client = new FakeClient();
    await migrate({ client, migrationsDir: dir });

    await expect(rollback({ client, migrationsDir: dir })).resolves.toEqual([{ version: '001', name: 'create_demo' }]);

    expect(client.queries.some((query) => query.sql.includes('DROP TABLE demo'))).toBe(true);
    expect(client.queries.some((query) => query.sql.includes('rolled_back_at'))).toBe(true);
  });
});
