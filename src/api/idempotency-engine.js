import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Consumer-side of the at-least-once ACK protocol.
 *
 * The outbound `AckBufferedWebSocketClient` retransmits any frame whose ACK it
 * never received. That makes delivery at-least-once, so the server must be able
 * to recognise a `msg_id` it has already processed and reply with a duplicate
 * ACK instead of running the business handler a second time.
 *
 * A `msg_id` is reserved synchronously (before awaiting the handler) so two
 * concurrent copies of the same frame cannot both run it. The reservation is
 * released when the handler throws, which deliberately leaves the frame
 * unacknowledged so the client retries -- an exception must not be cached as a
 * successful result.
 */
export class IdempotencyEngine {
  constructor({
    dbPath = ':memory:',
    ttlMs = 24 * 60 * 60 * 1000,
    pruneIntervalMs = 60 * 60 * 1000,
    logger = console,
  } = {}) {
    this.dbPath = dbPath;
    this.ttlMs = ttlMs;
    this.logger = logger;

    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }

    this.db = new Database(this.dbPath);
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency (
        msg_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('PROCESSING', 'PROCESSED')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency(created_at);
    `);

    this.stmtHas = this.db.prepare('SELECT status FROM idempotency WHERE msg_id = ?');
    this.stmtClaim = this.db.prepare(`
      INSERT OR IGNORE INTO idempotency (msg_id, status, created_at)
      VALUES (?, 'PROCESSING', ?)
    `);
    this.stmtMarkProcessed = this.db.prepare(`
      UPDATE idempotency SET status = 'PROCESSED', created_at = ? WHERE msg_id = ?
    `);
    this.stmtRelease = this.db.prepare('DELETE FROM idempotency WHERE msg_id = ?');
    this.stmtPrune = this.db.prepare('DELETE FROM idempotency WHERE created_at < ?');
    this.stmtUpsert = this.db.prepare(`
      INSERT OR REPLACE INTO idempotency (msg_id, status, created_at) VALUES (?, ?, ?)
    `);

    this.pruneTimer = setInterval(() => this.pruneExpired(), pruneIntervalMs);
    // A bookkeeping timer must never keep the process alive on its own.
    if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref();
  }

  /** Public so callers/metrics can inspect prior processing without side effects. */
  has(msgId) {
    return this.stmtHas.get(msgId) !== undefined;
  }

  /** Record a msg_id out-of-band (tests, backfills). */
  record(msgId, status = 'PROCESSED', createdAt = Date.now()) {
    return this.stmtUpsert.run(msgId, status, createdAt).changes > 0;
  }

  /**
   * Handle one inbound frame. Returns a small result object rather than
   * throwing, so a malformed message or a handler bug can never tear down the
   * surrounding socket loop.
   */
  async processIncoming(ws, rawMessage, businessHandler) {
    let frame;
    try {
      frame = JSON.parse(typeof rawMessage === 'string' ? rawMessage : rawMessage.toString());
    } catch {
      return { status: 'invalid' };
    }

    const msgId = frame?.msg_id;
    if (typeof msgId !== 'string' || msgId.length === 0) return { status: 'invalid' };

    if (this.has(msgId)) {
      this.ack(ws, msgId);
      return { status: 'duplicate', msgId };
    }

    const claim = this.stmtClaim.run(msgId, Date.now());
    if (claim.changes === 0) {
      // Lost a race with a concurrent copy of the same frame.
      this.ack(ws, msgId);
      return { status: 'duplicate', msgId };
    }

    try {
      await businessHandler(frame.data, { msgId });
      this.stmtMarkProcessed.run(Date.now(), msgId);
      this.ack(ws, msgId);
      return { status: 'processed', msgId };
    } catch (error) {
      // Release the reservation: the client will retransmit, and this time the
      // handler deserves another attempt.
      this.stmtRelease.run(msgId);
      this.logger?.error?.(`idempotency: handler failed for ${msgId}:`, error?.message ?? error);
      return { status: 'error', msgId, error };
    }
  }

  ack(ws, msgId) {
    if (!ws || typeof ws.send !== 'function') return;
    try {
      ws.send(JSON.stringify({ type: 'ACK', msg_id: msgId }));
    } catch (error) {
      this.logger?.error?.(`idempotency: failed to ACK ${msgId}:`, error?.message ?? error);
    }
  }

  pruneExpired(now = Date.now()) {
    return this.stmtPrune.run(now - this.ttlMs).changes;
  }

  close() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.db && this.db.open) this.db.close();
  }
}
