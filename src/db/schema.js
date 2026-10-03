import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  onchain_id INTEGER UNIQUE,
  creator TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  metadata_uri TEXT,
  licensing_fee TEXT,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS creators (
  address TEXT PRIMARY KEY,
  merit_score INTEGER DEFAULT 100,
  verified_skills TEXT,
  completed_escrows INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS escrows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  onchain_id INTEGER UNIQUE,
  client TEXT NOT NULL,
  creator TEXT NOT NULL,
  total_amount TEXT NOT NULL,
  remaining_balance TEXT NOT NULL,
  completed_milestones INTEGER DEFAULT 0,
  total_milestones INTEGER NOT NULL,
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS sync_cursor (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_creator ON assets(creator);
CREATE INDEX IF NOT EXISTS idx_escrows_creator ON escrows(creator);
`;

export function initDatabase(dbPath = ':memory:') {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new Database(dbPath);

  // WAL is a no-op for in-memory databases; harmless, but only for real files.
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(SCHEMA);
  return db;
}

export const statements = (db) => ({
  insertAsset: db.prepare(`
    INSERT OR IGNORE INTO assets (onchain_id, creator, fingerprint, metadata_uri, licensing_fee, timestamp)
    VALUES (@onchain_id, @creator, @fingerprint, @metadata_uri, @licensing_fee, @timestamp)
  `),
  listAssets: db.prepare(`
    SELECT onchain_id, creator, fingerprint, metadata_uri, licensing_fee, timestamp
    FROM assets ORDER BY timestamp DESC
  `),
  upsertCreator: db.prepare(`
    INSERT INTO creators (address, merit_score, verified_skills, completed_escrows)
    VALUES (@address, @merit_score, @verified_skills, 0)
    ON CONFLICT(address) DO NOTHING
  `),
  insertEscrow: db.prepare(`
    INSERT OR IGNORE INTO escrows
      (onchain_id, client, creator, total_amount, remaining_balance, completed_milestones, total_milestones, status)
    VALUES (@onchain_id, @client, @creator, @total_amount, @remaining_balance, 0, @total_milestones, 'active')
  `),
  getEscrow: db.prepare('SELECT * FROM escrows WHERE onchain_id = ?'),
  applyPayout: db.prepare(`
    UPDATE escrows
    SET remaining_balance = @remaining_balance,
        completed_milestones = @completed_milestones,
        status = @status
    WHERE onchain_id = @onchain_id
  `),
  incrementCreatorEscrows: db.prepare(`
    UPDATE creators SET completed_escrows = completed_escrows + 1 WHERE address = ?
  `),
  listCreators: db.prepare(`
    SELECT address, merit_score, verified_skills, completed_escrows FROM creators
  `),
  getCursor: db.prepare('SELECT value FROM sync_cursor WHERE key = ?'),
  setCursor: db.prepare(`
    INSERT INTO sync_cursor (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
});
