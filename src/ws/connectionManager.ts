/**
 * src/ws/connectionManager.ts
 *
 * WebSocket Connection Manager — race-condition fix for Issue #3.
 *
 * Problem:
 *   handleDisconnect() was async: it emitted a node_disconnected event to the
 *   event bus (awaiting acknowledgment) BEFORE removing the connection from the
 *   pool. During the 5 ms async gap, handleReconnect() saw the OLD connection
 *   still in the pool, raised DuplicateConnectionError, and rejected the
 *   reconnect. The node then waited 30 s before attempting again.
 *
 * Fix:
 *   1. Pool removal is now SYNCHRONOUS — happens before any async I/O.
 *   2. RECONNECT_GRACE_MS (500 ms) grace window: a rapid reconnect during the
 *      grace window is accepted and matched to the disconnecting slot.
 *   3. connectionGen counter: the pool stores the generation per node. A
 *      reconnect with gen > currentGen is accepted even while a disconnect
 *      handler is in-flight. The disconnect handler checks gen before
 *      completing — if gen has advanced, the disconnect is stale and skipped.
 *   4. The disconnect handler synchronously removes the pool entry and
 *      enqueues the event for asynchronous delivery, keeping pool state
 *      always consistent before async operations.
 */

import { EventEmitter } from 'events';
import {
  ConnectionPool,
  ConnectionEntry,
  WebSocketLike,
  DuplicateConnectionError,
  StaleGenerationError,
  RECONNECT_GRACE_MS,
} from './pool';
import { disconnectHandler } from './handlers/disconnectHandler';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export interface NodeConnectionOptions {
  /** Connection generation counter (u32, incremented by node on each connect). */
  connectionGen?: number;
}

export interface ConnectionManagerOptions {
  /** Custom pool instance (useful for testing). */
  pool?: ConnectionPool;
  /** EventEmitter for cross-module event propagation. */
  eventBus?: EventEmitter;
}

// ---------------------------------------------------------------------------
// ConnectionManager
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of WebSocket connections from network nodes.
 *
 * All public methods are safe to call concurrently within the Node.js event
 * loop; pool mutations happen synchronously before any awaited operations.
 */
export class ConnectionManager extends EventEmitter {
  private readonly pool: ConnectionPool;
  private readonly eventBus: EventEmitter;

  constructor(opts: ConnectionManagerOptions = {}) {
    super();
    this.pool = opts.pool ?? new ConnectionPool();
    this.eventBus = opts.eventBus ?? new EventEmitter();

    // Forward pool-level observability events.
    this.pool.on('reconnected', (entry: ConnectionEntry) => {
      this.emit('node_reconnected', entry.nodeId, entry.connectionGen);
    });
    this.pool.on('disconnected', (nodeId: string) => {
      this.emit('node_disconnected_final', nodeId);
    });
  }

  // -------------------------------------------------------------------------
  // Public API  (lines 85–125 in the original spec)
  // -------------------------------------------------------------------------

  /**
   * handleConnect — line ~85 in spec.
   *
   * Registers a new WebSocket connection for a node. Accepts rapid reconnects
   * during the RECONNECT_GRACE_MS grace window via the generation counter.
   *
   * @throws DuplicateConnectionError if the node already has an active
   *         connection AND is NOT within the grace window.
   */
  handleConnect(
    nodeId: string,
    socket: WebSocketLike,
    opts: NodeConnectionOptions = {},
  ): ConnectionEntry {
    const { connectionGen = 0 } = opts;

    // pool.add() is SYNCHRONOUS — state is consistent immediately.
    const entry = this.pool.add(nodeId, socket, connectionGen);

    this.emit('node_connected', nodeId, connectionGen);
    return entry;
  }

  /**
   * handleDisconnect — lines 90–119 in spec (now race-condition-free).
   *
   * CRITICAL CHANGE vs. original:
   *   Pool removal (pool.beginDisconnect) now happens SYNCHRONOUSLY at the
   *   start of this function. The event bus notification is enqueued for
   *   async delivery AFTER the pool state is already consistent.
   *
   *   Any reconnect that arrives during the event-bus delay will see the slot
   *   as 'disconnecting' (not 'connected') and will be accepted normally.
   *
   * @param nodeId        The disconnecting node.
   * @param connectionGen The generation of the connection that dropped. If the
   *                      pool's currentGen is already higher, this disconnect
   *                      is stale and will be skipped.
   */
  handleDisconnect(nodeId: string, connectionGen?: number): void {
    // ── Step 1: Synchronous pool mutation ────────────────────────────────────
    // This happens BEFORE any await, so no reconnect can see a stale 'connected'
    // entry while the event bus acknowledgment is in-flight.
    const applied = this.pool.beginDisconnect(nodeId, connectionGen);

    if (!applied) {
      // Either the node was not found, or the generation has already advanced
      // (meaning a reconnect already replaced this connection). Skip.
      return;
    }

    // ── Step 2: Async event delivery (non-blocking) ──────────────────────────
    // We do NOT await this — it runs asynchronously after the pool is already
    // in a consistent 'disconnecting' state.
    disconnectHandler(nodeId, connectionGen, this.eventBus).catch((err: Error) => {
      // Log but do not re-throw; the pool is already updated.
      this.emit('error', new Error(`Event bus delivery failed for ${nodeId}: ${err.message}`));
    });
  }

  /**
   * handleReconnect — lines 120–135 in spec (now race-condition-free).
   *
   * Accepts a reconnecting node. If the node is within the RECONNECT_GRACE_MS
   * window (state === 'disconnecting'), the connection is immediately accepted
   * provided the incoming connectionGen is strictly greater than the stored gen.
   *
   * @throws DuplicateConnectionError  if already 'connected' with no grace.
   * @throws StaleGenerationError      if gen is not advancing.
   */
  handleReconnect(
    nodeId: string,
    socket: WebSocketLike,
    opts: NodeConnectionOptions = {},
  ): ConnectionEntry {
    // Delegate entirely to pool.add() which contains all the
    // grace-window / generation-counter logic.
    return this.handleConnect(nodeId, socket, opts);
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  /** Returns whether nodeId is actively connected (not in grace window). */
  isConnected(nodeId: string): boolean {
    return this.pool.isConnected(nodeId);
  }

  /** Returns whether nodeId is in the disconnect grace window. */
  isDisconnecting(nodeId: string): boolean {
    return this.pool.isDisconnecting(nodeId);
  }

  /** Current total entries in any state. */
  get poolSize(): number {
    return this.pool.size;
  }

  /** Current number of fully connected entries. */
  get activeConnections(): number {
    return this.pool.activeCount;
  }

  /** Get a pool entry directly (for diagnostics / testing). */
  getEntry(nodeId: string): ConnectionEntry | undefined {
    return this.pool.get(nodeId);
  }

  /**
   * Force-evict a node immediately, bypassing the grace window.
   * Use for hard errors, security events, or server-side node removal.
   */
  evict(nodeId: string): boolean {
    return this.pool.forceRemove(nodeId);
  }

  /** Tear down all connections (e.g., on server shutdown). */
  shutdown(): void {
    this.pool.clear();
    this.emit('shutdown');
  }
}

// ---------------------------------------------------------------------------
// Re-export errors for consumer convenience
// ---------------------------------------------------------------------------
export { DuplicateConnectionError, StaleGenerationError, RECONNECT_GRACE_MS };
