const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_SCHEMA_TABLE = 'schema_migrations';
const MIGRATION_FILE = /^(\d{3,14})[_-](.+)\.(sql|js)$/;

function quoteIdent(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function parseMigrationFile(filePath) {
  const fileName = path.basename(filePath);
  const match = fileName.match(MIGRATION_FILE);
  if (!match) return null;

  const contents = fs.readFileSync(filePath, 'utf8');
  return {
    version: match[1],
    name: match[2],
    extension: match[3],
    fileName,
    filePath,
    checksum: crypto.createHash('sha256').update(contents).digest('hex'),
    contents,
  };
}

function loadMigrations(migrationsDir) {
  return fs.readdirSync(migrationsDir)
    .map((file) => parseMigrationFile(path.join(migrationsDir, file)))
    .filter(Boolean)
    .sort((a, b) => a.version.localeCompare(b.version) || a.fileName.localeCompare(b.fileName));
}

async function ensureMigrationTable(client, tableName = DEFAULT_SCHEMA_TABLE) {
  const table = quoteIdent(tableName);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      version VARCHAR(32) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      execution_ms INTEGER NOT NULL,
      rollback_sql TEXT,
      rolled_back_at TIMESTAMPTZ
    );
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ${tableName}_applied_at_idx ON ${table} (applied_at);`);
}

async function getAppliedVersions(client, tableName = DEFAULT_SCHEMA_TABLE) {
  const table = quoteIdent(tableName);
  const { rows } = await client.query(`SELECT version, checksum FROM ${table} WHERE rolled_back_at IS NULL ORDER BY version ASC;`);
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

function splitSqlSections(contents) {
  const downMarker = /^\s*--\s*\+migrate\s+Down\s*$/im;
  const upMarker = /^\s*--\s*\+migrate\s+Up\s*$/im;
  const downMatch = contents.match(downMarker);
  const upMatch = contents.match(upMarker);

  if (!downMatch) return { upSql: contents.trim(), downSql: null };

  const downIndex = downMatch.index;
  const upStart = upMatch ? upMatch.index + upMatch[0].length : 0;
  return {
    upSql: contents.slice(upStart, downIndex).trim(),
    downSql: contents.slice(downIndex + downMatch[0].length).trim(),
  };
}

async function applyMigration(client, migration, tableName = DEFAULT_SCHEMA_TABLE) {
  const table = quoteIdent(tableName);
  const start = Date.now();
  const { upSql, downSql } = splitSqlSections(migration.contents);

  await client.query('BEGIN');
  try {
    if (migration.extension === 'sql') {
      if (upSql) await client.query(upSql);
    } else {
      const script = require(migration.filePath);
      if (typeof script.up !== 'function') throw new Error(`${migration.fileName} must export up(client)`);
      await script.up(client);
    }

    await client.query(
      `INSERT INTO ${table} (version, name, checksum, execution_ms, rollback_sql)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, rolled_back_at = NULL, applied_at = NOW(), execution_ms = EXCLUDED.execution_ms, rollback_sql = EXCLUDED.rollback_sql;`,
      [migration.version, migration.name, migration.checksum, Date.now() - start, downSql]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function rollbackMigration(client, migration, tableName = DEFAULT_SCHEMA_TABLE) {
  const table = quoteIdent(tableName);
  await client.query('BEGIN');
  try {
    if (migration.extension === 'sql') {
      const { downSql } = splitSqlSections(migration.contents);
      if (!downSql) throw new Error(`${migration.fileName} is missing a -- +migrate Down rollback section`);
      await client.query(downSql);
    } else {
      const script = require(migration.filePath);
      if (typeof script.down !== 'function') throw new Error(`${migration.fileName} must export down(client)`);
      await script.down(client);
    }

    await client.query(`UPDATE ${table} SET rolled_back_at = NOW() WHERE version = $1;`, [migration.version]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function migrate({ client, migrationsDir = path.join(process.cwd(), 'backend/migrations'), tableName = DEFAULT_SCHEMA_TABLE } = {}) {
  await ensureMigrationTable(client, tableName);
  const applied = await getAppliedVersions(client, tableName);
  const pending = loadMigrations(migrationsDir).filter((migration) => !applied.has(migration.version));
  for (const migration of pending) await applyMigration(client, migration, tableName);
  return pending.map(({ version, name }) => ({ version, name }));
}

async function rollback({ client, migrationsDir = path.join(process.cwd(), 'backend/migrations'), tableName = DEFAULT_SCHEMA_TABLE, steps = 1 } = {}) {
  await ensureMigrationTable(client, tableName);
  const applied = await getAppliedVersions(client, tableName);
  const appliedMigrations = loadMigrations(migrationsDir).filter((migration) => applied.has(migration.version)).reverse().slice(0, steps);
  for (const migration of appliedMigrations) await rollbackMigration(client, migration, tableName);
  return appliedMigrations.map(({ version, name }) => ({ version, name }));
}

module.exports = { loadMigrations, migrate, rollback, splitSqlSections };
