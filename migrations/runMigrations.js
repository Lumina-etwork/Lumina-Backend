#!/usr/bin/env node
const path = require('path');
const { Pool } = require('pg');
const { migrate, rollback } = require('../backend/src/database/migrationManager');

async function main() {
  const command = process.argv[2] || 'up';
  const migrationsDir = process.env.MIGRATIONS_DIR || path.join(__dirname, '..', 'backend', 'migrations');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const result = command === 'down'
      ? await rollback({ client, migrationsDir, steps: Number(process.env.MIGRATION_STEPS || 1) })
      : await migrate({ client, migrationsDir });
    console.log(JSON.stringify({ command, migrations: result }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
