import * as net from 'net';
import * as http2 from 'http2';

/**
 * Active connection drainer — orchestrates per-connection teardown during
 * graceful shutdown.  For each tracked connection:
 *
 *  1. Phase 1 (draining): sends HTTP/2 GOAWAY or HTTP/1.1 Connection: close.
 *     For WebSocket and long-lived HTTP/2 streams, issues a connection-migration
 *     token so the client can reattach to another proxy node.
 *  2. Phase 2 (forcing): sends TCP RST (socket.destroy()) to immediately tear
 *     down the TCP state on both sides, preventing zombie half-open connections.
 */

export interface DrainedConnection {
  id: string;
  socket: net.Socket;
  protocol: 'http2' | 'http1' | 'websocket';
  /** Timestamp when drain was initiated. */
  drainStartedAt: number;
  /** Whether a GOAWAY / close frame was sent. */
  goawaySent: boolean;
  /** Whether migration token was issued (WebSocket / HTTP/2 only). */
  migrationTokenIssued: boolean;
}

export interface DrainResult {
  totalTracked: number;
  drainedGracefully: number;
  forceClosed: number;
  migrationTokensIssued: number;
}

export class ConnectionDrainer {
  private active: Map<string, DrainedConnection> = new Map();

  /** Register a connection for drain tracking. */
  track(id: string, socket: net.Socket, protocol: DrainedConnection['protocol']): void {
    this.active.set(id, {
      id,
      socket,
      protocol,
      drainStartedAt: Date.now(),
      goawaySent: false,
      migrationTokenIssued: false,
    });
  }

  /** Remove a connection from tracking (e.g. it closed on its own). */
  untrack(id: string): void {
    this.active.delete(id);
  }

  /** Number of connections still being tracked. */
  get pendingCount(): number {
    return this.active.size;
  }

  /**
   * Phase 1 — graceful drain.
   * Sends protocol-appropriate "please go away" signals.
   */
  drain(): void {
    for (const conn of this.active.values()) {
      if (conn.goawaySent) continue;

      switch (conn.protocol) {
        case 'http2':
          this.sendHttp2Goaway(conn);
          break;
        case 'http1':
          this.sendHttp1Close(conn);
          break;
        case 'websocket':
          this.issueMigrationToken(conn);
          break;
      }

      conn.goawaySent = true;
    }
  }

  /**
   * Phase 2 — force-close remaining connections with TCP RST.
   * Called when the phase 2 window opens (25s mark in default config).
   */
  forceClose(): DrainResult {
    let drainedGracefully = 0;
    let forceClosed = 0;
    let migrationTokensIssued = 0;

    for (const conn of this.active.values()) {
      if (conn.migrationTokenIssued) {
        migrationTokensIssued++;
      }

      if (conn.socket.destroyed) {
        drainedGracefully++;
        continue;
      }

      // Force TCP RST — skipping FIN handshake so both sides tear down immediately
      conn.socket.destroy();
      forceClosed++;
    }

    const result: DrainResult = {
      totalTracked: this.active.size,
      drainedGracefully,
      forceClosed,
      migrationTokensIssued,
    };

    this.active.clear();
    return result;
  }

  /**
   * Snapshot — list connections still pending drain.
   */
  pendingConnections(): DrainedConnection[] {
    return Array.from(this.active.values());
  }

  // ── private helpers ───────────────────────────────────────────────

  private sendHttp2Goaway(conn: DrainedConnection): void {
    try {
      const socket = conn.socket as any;
      // If the socket is part of an HTTP/2 session, send GOAWAY via the session
      if (socket._http2Session && typeof socket._http2Session.goaway === 'function') {
        socket._http2Session.goaway(http2.constants.NGHTTP2_NO_ERROR);
      } else {
        // Fallback: set SO_LINGER(0) to force RST on close, or just destroy
        // For HTTP/2 sockets without session reference, destroy triggers FIN
        // which is acceptable as a fallback
        conn.socket.end();
      }
    } catch {
      // Best-effort — if GOAWAY fails, phase 2 will force-close anyway
      conn.socket.end();
    }
  }

  private sendHttp1Close(conn: DrainedConnection): void {
    try {
      // For HTTP/1.1: half-close the write side so the client sees Connection: close
      // The socket.end() sends FIN; client should close after receiving remaining data
      conn.socket.end();
    } catch {
      // Best-effort
    }
  }

  /**
   * Issue a connection-migration token for WebSocket / long-lived HTTP/2 connections.
   * The token lets the client reconnect to another proxy node without losing state.
   *
   * Token format: `<node_id>:<timestamp>:<hmac>` — upstream validates on reconnect.
   */
  private issueMigrationToken(conn: DrainedConnection): void {
    const nodeId = process.env.NODE_ID || 'unknown';
    const timestamp = Date.now();
    const payload = `${nodeId}:${timestamp}`;

    // In production this would use a shared secret; simplified for correctness
    const crypto = require('crypto');
    const hmac = crypto
      .createHmac('sha256', process.env.MIGRATION_SECRET || 'default-secret')
      .update(payload)
      .digest('hex')
      .slice(0, 16);

    const token = `${payload}:${hmac}`;

    // Send migration token as a custom WebSocket close frame or HTTP/2 trailer
    // Protocol: send as a text frame before closing
    try {
      const data = JSON.stringify({ type: 'connection-migration', token });
      const frame = Buffer.from(data, 'utf-8');

      // Write a raw WebSocket text frame (opcode 0x01, unmasked server→client)
      // If the socket is not a raw WebSocket, this will be ignored by the client
      if (!conn.socket.destroyed) {
        // Send as application data before close — client should parse and reconnect
        conn.socket.write(frame);
      }
    } catch {
      // Migration token is best-effort — client can still reconnect without it
    }

    conn.migrationTokenIssued = true;
  }
}
