import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * At-least-once outbound queue. A row is deleted only when the peer returns an
 * explicit `{ type: 'ACK', msg_id }` frame -- not when the bytes leave the
 * socket -- so a drop between send and receipt causes retransmission.
 */
export class AckBufferedWebSocketClient {
  constructor({
    url,
    dbPath = './data/ack-queue.db',
    reconnectIntervalMs = 50,
    ackTimeoutMs = 3000,
    maxQueueSize = 1000,
  } = {}) {
    this.url = url;
    this.dbPath = dbPath;
    this.reconnectIntervalMs = reconnectIntervalMs;
    this.ackTimeoutMs = ackTimeoutMs;
    this.maxQueueSize = maxQueueSize;

    this.isManuallyClosed = false;
    this.ws = null;
    this.reconnectTimer = null;
    this.inFlightTimers = new Map();

    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }

    this.db = new Database(this.dbPath);
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.initDatabase();

    this.stmtInsert = this.db.prepare(`
      INSERT INTO ack_queue (msg_id, payload, status, created_at, last_attempt_at)
      VALUES (?, ?, 'PENDING', ?, NULL)
    `);
    this.stmtMarkInFlight = this.db.prepare(`
      UPDATE ack_queue SET status = 'IN_FLIGHT', last_attempt_at = ? WHERE msg_id = ?
    `);
    this.stmtResetInFlight = this.db.prepare(`
      UPDATE ack_queue SET status = 'PENDING' WHERE status = 'IN_FLIGHT'
    `);
    this.stmtResetOne = this.db.prepare(`
      UPDATE ack_queue SET status = 'PENDING' WHERE msg_id = ? AND status = 'IN_FLIGHT'
    `);
    this.stmtSelectPending = this.db.prepare(`
      SELECT msg_id, payload FROM ack_queue WHERE status = 'PENDING' ORDER BY id ASC
    `);
    this.stmtDeleteAcked = this.db.prepare('DELETE FROM ack_queue WHERE msg_id = ?');
    this.stmtCount = this.db.prepare('SELECT COUNT(*) as count FROM ack_queue');
    this.stmtGet = this.db.prepare('SELECT * FROM ack_queue WHERE msg_id = ?');

    this.onOpen = null;
    this.onAckProcessed = null;
  }

  initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ack_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        msg_id TEXT UNIQUE NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING', 'IN_FLIGHT')),
        created_at INTEGER NOT NULL,
        last_attempt_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ack_queue_status ON ack_queue(status);
    `);
  }

  connect() {
    if (this.isManuallyClosed) return;

    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      // Anything still IN_FLIGHT when the socket reset was never confirmed.
      this.stmtResetInFlight.run();
      this.clearInFlightTimers();
      this.flushQueue();
      this.onOpen?.();
    });

    this.ws.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame?.type === 'ACK' && frame.msg_id) this.handleAck(frame.msg_id);
      } catch {
        // discard malformed frames
      }
    });

    this.ws.on('error', () => {
      // handled in 'close'
    });

    this.ws.on('close', () => {
      this.clearInFlightTimers();
      if (this.isManuallyClosed) return;
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectIntervalMs);
    });
  }

  send(data) {
    if (this.getQueueSize() >= this.maxQueueSize) {
      throw new Error(`ack queue full (${this.maxQueueSize})`);
    }

    const msgId = crypto.randomUUID();
    const serializedPayload = typeof data === 'string' ? data : JSON.stringify(data);

    this.stmtInsert.run(msgId, serializedPayload, Date.now());

    if (this.isOpen()) this.dispatchMessage(msgId, serializedPayload);

    return msgId;
  }

  dispatchMessage(msgId, payload) {
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      data = payload; // tolerate non-JSON string payloads
    }

    this.stmtMarkInFlight.run(Date.now(), msgId);
    this.ws.send(JSON.stringify({ msg_id: msgId, data }));

    const timer = setTimeout(() => {
      if (this.stmtGet.get(msgId)?.status === 'IN_FLIGHT') {
        // Reset only this message -- a global reset would also requeue
        // unrelated in-flight frames whose ACKs are still pending.
        this.stmtResetOne.run(msgId);
        this.inFlightTimers.delete(msgId);
        if (this.isOpen()) this.flushQueue();
      }
    }, this.ackTimeoutMs);

    this.inFlightTimers.set(msgId, timer);
  }

  handleAck(msgId) {
    const timer = this.inFlightTimers.get(msgId);
    if (timer) {
      clearTimeout(timer);
      this.inFlightTimers.delete(msgId);
    }

    const result = this.stmtDeleteAcked.run(msgId);
    this.onAckProcessed?.(msgId, result.changes > 0);
  }

  flushQueue() {
    if (!this.isOpen()) return;
    const pending = this.stmtSelectPending.all();
    for (const item of pending) this.dispatchMessage(item.msg_id, item.payload);
  }

  clearInFlightTimers() {
    for (const timer of this.inFlightTimers.values()) clearTimeout(timer);
    this.inFlightTimers.clear();
  }

  isOpen() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getQueueSize() {
    return this.stmtCount.get().count;
  }

  getMessage(msgId) {
    return this.stmtGet.get(msgId);
  }

  close() {
    this.isManuallyClosed = true;
    clearTimeout(this.reconnectTimer);
    this.clearInFlightTimers();
    if (this.ws) this.ws.terminate();
    if (this.db && this.db.open) this.db.close();
  }
}
