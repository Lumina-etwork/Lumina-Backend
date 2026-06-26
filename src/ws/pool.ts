/**
 * src/ws/pool.ts
 *
 * WebSocket Connection Pool — ordered mutations with generation counter.
 *
 * Resolution for Issue #3: WebSocket Connection Pool Exhaustion Under
 * Concurrent Disconnect/Reconnect Storm.
 *
 * Key design decisions:
 *  - All state mutations are synchronous and happen before any async I/O.
 *  - Each connection slot tracks a monotonically increasing connectionGen.
 *  - During the RECONNECT_GRACE_MS window, the slot stays "disconnecting"
 *    so a rapid reconnect can claim it without being rejected.
 *  - Pool capacity: 10,000 connections (configurable via MAX_POOL_CAPACITY).
 */

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Grace window (ms) during which a rapid reconnect is accepted for a
 *  node that has started disconnecting. */
export const RECONNECT_GRACE_MS = 500;

/** Maximum number of concurrent connections the pool will hold. */
export const MAX_POOL_CAPACITY = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Possible lifecycle states for a connection slot. */
export type ConnectionState =
  | 'connected'
  | 'disconnecting' // within RECONNECT_GRACE_MS — still holding slot
  | 'disconnected';

/** A single connection entry stored in the pool. */
export interface ConnectionEntry {
  /** Node identifier (unique per physical node). */
  nodeId: string;
  /** The raw WebSocket object (or equivalent handle). */
  socket: WebSocketLike;
  /** Monotonically increasing counter — incremented by the node on each new
   *  connection attempt. Allows the pool to detect stale disconnect handlers. */
  connectionGen: number;
  /** Current lifecycle state of this connection slot. */
  state: ConnectionState;
  /** Timestamp (ms) when the grace-window timer started, if state ===
   *  'disconnecting'. */
  disconnectingAt: number | null;
  /** The timer handle for the grace-window expiry, if any. */
  graceTimer: ReturnType<typeof setTimeout> | null;
}

/** Minimal interface so the pool is not hard-coupled to a specific WS lib. */
export interface WebSocketLike {
  nodeId?: string;
  close(): void;
}

/** Events emitted by the pool for observability. */
export interface PoolEvents {
  /** Fired after a connection is added synchronously. */
  connected: (entry: ConnectionEntry) => void;
  /** Fired after the pool slot transitions to 'disconnecting'. */
  disconnecting: (entry: ConnectionEntry) => void;
  /** Fired after the slot is fully removed from the pool. */
  disconnected: (nodeId: string) => void;
  /** Fired when a reconnect is accepted (replaces the old slot). */
  reconnected: (entry: ConnectionEntry) => void;
  /** Fired when a connection is rejected (e.g., already connected, stale gen). */
  rejected: (nodeId: string, reason: string) => void;
}

// ---------------------------------------------------------------------------
// ConnectionPool
// ---------------------------------------------------------------------------

/**
 * Thread-safe* WebSocket connection pool.
 *
 * (* "thread-safe" here means: all synchronous mutations happen atomically
 *   within a single JS event-loop tick before any async work is scheduled.)
 */
export class ConnectionPool extends EventEmitter {
  /** Primary index: nodeId → ConnectionEntry */
  private readonly entries = new Map<string, ConnectionEntry>();

  constructor(private readonly capacity = MAX_POOL_CAPACITY) {
    super();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Add a new connection to the pool.
   *
   * Accepts the connection if:
   *   1. The pool is not at capacity.
   *   2. No entry exists for this nodeId (normal first-connect).
   *   3. An entry exists but is in 'disconnecting' grace window AND the
   *      incoming connectionGen is strictly greater (rapid reconnect path).
   *   4. An entry exists but is in 'disconnecting' grace window AND the gen
   *      is not tracked by the node (legacy nodes without gen support use 0).
   *
   * Rejects with DuplicateConnectionError if a 'connected' entry already
   * exists for this nodeId (invariant: exactly 1 connection per node).
   *
   * @returns The newly created/replaced ConnectionEntry.
   */
  add(nodeId: string, socket: WebSocketLike, connectionGen = 0): ConnectionEntry {
    if (this.entries.size >= this.capacity && !this.entries.has(nodeId)) {
      throw new PoolCapacityError(
        `Pool capacity ${this.capacity} reached — cannot add node ${nodeId}`,
      );
    }

    const existing = this.entries.get(nodeId);

    if (existing) {
      if (existing.state === 'connected') {
        // Duplicate: hard reject — invariant violation.
        this.emit('rejected', nodeId, 'DuplicateConnection');
        throw new DuplicateConnectionError(
          `Node ${nodeId} already has an active connection (gen=${existing.connectionGen})`,
        );
      }

      if (existing.state === 'disconnecting') {
        // Grace-window reconnect path.
        // Accept if incoming gen is greater, or gen is 0 (legacy node).
        if (connectionGen > existing.connectionGen || connectionGen === 0) {
          return this._replaceEntry(existing, socket, connectionGen);
        }

        // Stale reconnect (gen <= existing but existing is 'disconnecting').
        this.emit('rejected', nodeId, 'StaleGeneration');
        throw new StaleGenerationError(
          `Reconnect gen ${connectionGen} ≤ existing gen ${existing.connectionGen} for node ${nodeId}`,
        );
      }

      if (existing.state === 'disconnected') {
        // Slot was retained but fully expired — replace it.
        return this._replaceEntry(existing, socket, connectionGen);
      }
    }

    // Clean add — no existing entry.
    const entry: ConnectionEntry = {
      nodeId,
      socket,
      connectionGen,
      state: 'connected',
      disconnectingAt: null,
      graceTimer: null,
    };

    this.entries.set(nodeId, entry);
    this.emit('connected', entry);
    return entry;
  }

  /**
   * Begin disconnecting a node.
   *
   * IMPORTANT: This is synchronous — the slot transitions to 'disconnecting'
   * immediately so that any concurrent reconnect handler sees the slot as
   * available within the grace window.
   *
   * After RECONNECT_GRACE_MS the slot is fully removed unless a reconnect
   * has already replaced it.
   *
   * @param nodeId  The node to disconnect.
   * @param gen     The connectionGen of the connection being disconnected.
   *                If undefined, the check is skipped (legacy callers).
   * @returns       true if the disconnect was applied; false if skipped
   *                (e.g., the gen has already advanced — stale handler).
   */
  beginDisconnect(nodeId: string, gen?: number): boolean {
    const entry = this.entries.get(nodeId);

    if (!entry) {
      return false; // Node was never connected or already removed.
    }

    // Stale disconnect handler check: if the generation has advanced (node
    // already reconnected), this disconnect is obsolete — skip it.
    if (gen !== undefined && entry.connectionGen > gen) {
      return false;
    }

    if (entry.state !== 'connected') {
      // Already disconnecting/disconnected — idempotent.
      return false;
    }

    // ── Synchronous state mutation happens HERE, before any async work ──
    entry.state = 'disconnecting';
    entry.disconnectingAt = Date.now();

    this.emit('disconnecting', entry);

    // Schedule the grace-window expiry.
    entry.graceTimer = setTimeout(() => {
      this._expireGraceWindow(nodeId, entry.connectionGen);
    }, RECONNECT_GRACE_MS);

    return true;
  }

  /**
   * Force-remove a node's connection immediately (e.g., server-initiated
   * eviction, hard error). Skips the grace window.
   */
  forceRemove(nodeId: string): boolean {
    const entry = this.entries.get(nodeId);
    if (!entry) return false;

    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }

    this.entries.delete(nodeId);
    this.emit('disconnected', nodeId);
    return true;
  }

  /** Look up an entry by nodeId. */
  get(nodeId: string): ConnectionEntry | undefined {
    return this.entries.get(nodeId);
  }

  /** Returns true if nodeId has a 'connected' entry. */
  isConnected(nodeId: string): boolean {
    return this.entries.get(nodeId)?.state === 'connected';
  }

  /** Returns true if nodeId has a 'disconnecting' entry (within grace). */
  isDisconnecting(nodeId: string): boolean {
    return this.entries.get(nodeId)?.state === 'disconnecting';
  }

  /** Number of entries in any state. */
  get size(): number {
    return this.entries.size;
  }

  /** Number of entries in 'connected' state only. */
  get activeCount(): number {
    let count = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'connected') count++;
    }
    return count;
  }

  /** Drain all connections (e.g., on server shutdown). */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
    }
    this.entries.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Replace an existing (disconnecting/disconnected) entry with a fresh
   * connection for the same node. Called on rapid-reconnect path.
   */
  private _replaceEntry(
    existing: ConnectionEntry,
    socket: WebSocketLike,
    connectionGen: number,
  ): ConnectionEntry {
    // Cancel any pending grace-window expiry.
    if (existing.graceTimer) {
      clearTimeout(existing.graceTimer);
      existing.graceTimer = null;
    }

    // Mutate in-place (keeps the same Map slot — no delete+insert race).
    existing.socket = socket;
    existing.connectionGen = connectionGen;
    existing.state = 'connected';
    existing.disconnectingAt = null;

    this.emit('reconnected', existing);
    return existing;
  }

  /**
   * Called when the grace-window timer fires. Remove the slot only if the
   * generation has not advanced (i.e., the reconnect did not happen).
   */
  private _expireGraceWindow(nodeId: string, gen: number): void {
    const entry = this.entries.get(nodeId);

    if (!entry) return; // Already removed by forceRemove.

    if (entry.connectionGen !== gen) {
      // Generation advanced — reconnect succeeded during grace window.
      // The slot is now 'connected'; do not remove.
      return;
    }

    if (entry.state !== 'disconnecting') {
      // State changed; do not interfere.
      return;
    }

    this.entries.delete(nodeId);
    this.emit('disconnected', nodeId);
  }
}

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class DuplicateConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateConnectionError';
  }
}

export class StaleGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleGenerationError';
  }
}

export class PoolCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoolCapacityError';
  }
}
