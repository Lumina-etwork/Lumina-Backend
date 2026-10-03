import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';

/**
 * Disk-backed variant of BufferedWebSocketClient. Undelivered frames survive
 * process death because they live in SQLite rather than in memory, and are
 * drained FIFO on the next successful connection.
 */
export class SqliteBufferedWebSocketClient {
  constructor({
    url,
    dbPath = './data/offline-queue.db',
    reconnectIntervalMs = 50,
    maxQueueSize = 1000,
  } = {}) {
    this.url = url;
    this.dbPath = dbPath;
    this.reconnectIntervalMs = reconnectIntervalMs;
    this.maxQueueSize = maxQueueSize;

    this.isManuallyClosed = false;
    this.ws = null;
    this.reconnectTimer = null;

    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }

    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.initDatabase();

    this.stmtInsert = this.db.prepare(`
      INSERT INTO outbound_queue (payload, created_at) VALUES (?, ?)
    `);
    this.stmtSelectPending = this.db.prepare(`
      SELECT id, payload FROM outbound_queue ORDER BY id ASC
    `);
    this.stmtDelete = this.db.prepare('DELETE FROM outbound_queue WHERE id = ?');
    this.stmtCount = this.db.prepare('SELECT COUNT(*) as count FROM outbound_queue');
    this.stmtPruneOldest = this.db.prepare(`
      DELETE FROM outbound_queue WHERE id IN (
        SELECT id FROM outbound_queue ORDER BY id ASC LIMIT ?
      )
    `);

    // Test instrumentation hooks
    this.onOpen = null;
    this.onQueueFlushed = null;
  }

  initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbound_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_queue_id ON outbound_queue(id);
    `);
  }

  connect() {
    if (this.isManuallyClosed) return;

    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.flushQueue();
      if (this.onOpen) this.onOpen();
    });

    this.ws.on('error', () => {
      // Handled in 'close'
    });

    this.ws.on('close', () => {
      if (this.isManuallyClosed) return;
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectIntervalMs);
    });
  }

  send(data) {
    const serialized = typeof data === 'string' ? data : JSON.stringify(data);

    if (this.isOpen()) {
      this.ws.send(serialized);
      return { sentImmediately: true, queuedId: null };
    }

    const currentCount = this.getQueueSize();
    if (currentCount >= this.maxQueueSize) {
      this.stmtPruneOldest.run(currentCount - this.maxQueueSize + 1);
    }

    const info = this.stmtInsert.run(serialized, Date.now());
    return { sentImmediately: false, queuedId: Number(info.lastInsertRowid) };
  }

  flushQueue() {
    if (!this.isOpen()) return;

    const pending = this.stmtSelectPending.all();
    if (pending.length === 0) return;

    for (const record of pending) {
      this.ws.send(record.payload);
      this.stmtDelete.run(record.id);
    }

    if (this.onQueueFlushed) {
      this.onQueueFlushed(pending.length);
    }
  }

  isOpen() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getQueueSize() {
    const row = this.stmtCount.get();
    return row ? row.count : 0;
  }

  close() {
    this.isManuallyClosed = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.terminate();
    }
    if (this.db && this.db.open) {
      this.db.close();
    }
  }
}
