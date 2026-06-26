/**
 * src/ws/handlers/disconnectHandler.ts
 *
 * Disconnect handler — uses a synchronous local event queue instead of the
 * async event bus, so pool state is never stale during delivery.
 *
 * Resolution for Issue #3:
 *   The original implementation awaited an event bus acknowledgment WHILE the
 *   connection was still in the pool (state = 'connected'). During that await,
 *   any reconnect attempt would see a stale 'connected' entry and be rejected.
 *
 *   New approach:
 *   1. pool.beginDisconnect() transitions the slot to 'disconnecting' BEFORE
 *      this handler is called.
 *   2. This handler enqueues the disconnect event into a LOCAL in-process queue
 *      that is flushed asynchronously.
 *   3. A reconnect that arrives while the async flush is pending sees the slot
 *      as 'disconnecting' (within grace window) and is accepted.
 */

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Local event queue
// ---------------------------------------------------------------------------

/** Shape of a single queued event. */
interface QueuedEvent {
  type: 'node_disconnected';
  nodeId: string;
  connectionGen: number | undefined;
  timestamp: number;
}

/**
 * In-process FIFO queue for disconnect events.
 *
 * Events are drained asynchronously via setImmediate so they run after all
 * synchronous work in the current tick (e.g., pool mutations, reconnect
 * handlers) has completed.
 */
class LocalEventQueue {
  private readonly queue: QueuedEvent[] = [];
  private flushScheduled = false;
  private readonly handlers: Map<string, ((event: QueuedEvent) => void)[]> = new Map();

  /**
   * Enqueue a disconnect event for asynchronous delivery.
   * Returns immediately — does NOT block.
   */
  enqueue(event: QueuedEvent): void {
    this.queue.push(event);
    this._scheduleFlush();
  }

  /**
   * Register a handler for a specific event type.
   */
  on(type: string, handler: (event: QueuedEvent) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  private _scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;

    // setImmediate runs after all I/O callbacks in the current event-loop
    // tick, but before setTimeout. This guarantees the pool mutation
    // (beginDisconnect) has completed before any subscriber processes the
    // disconnect event.
    setImmediate(() => this._flush());
  }

  private _flush(): void {
    this.flushScheduled = false;
    // Drain the queue.
    while (this.queue.length > 0) {
      const event = this.queue.shift()!;
      const handlers = this.handlers.get(event.type) ?? [];
      for (const h of handlers) {
        try {
          h(event);
        } catch {
          // Individual handler errors do not stop the queue.
        }
      }
    }
  }
}

/** Singleton local event queue shared within this process. */
export const localEventQueue = new LocalEventQueue();

// ---------------------------------------------------------------------------
// disconnectHandler
// ---------------------------------------------------------------------------

/**
 * Handles the async portion of a node disconnect.
 *
 * Called AFTER pool.beginDisconnect() has already transitioned the slot to
 * 'disconnecting' (synchronously). This function is therefore non-blocking
 * with respect to the pool.
 *
 * It:
 *   1. Enqueues a 'node_disconnected' event to the local queue (synchronous).
 *   2. Optionally notifies an external event bus (fire-and-forget).
 *
 * The local queue is flushed asynchronously (setImmediate), so any reconnect
 * that arrives in the same tick will be processed before the downstream
 * subscribers even see the disconnect event.
 *
 * @param nodeId        The disconnecting node.
 * @param connectionGen Generation counter of the dropped connection.
 * @param eventBus      Optional external event bus for cross-service delivery.
 */
export async function disconnectHandler(
  nodeId: string,
  connectionGen: number | undefined,
  eventBus?: EventEmitter,
): Promise<void> {
  const event: QueuedEvent = {
    type: 'node_disconnected',
    nodeId,
    connectionGen,
    timestamp: Date.now(),
  };

  // ── Step 1: Synchronous local queue enqueue ──────────────────────────────
  // This does NOT block or yield. The pool slot is already 'disconnecting'.
  localEventQueue.enqueue(event);

  // ── Step 2: External event bus (fire-and-forget, optional) ───────────────
  // We emit but do NOT await any acknowledgment. If the bus is slow, that is
  // its problem — the pool state is already consistent.
  if (eventBus) {
    eventBus.emit('node_disconnected', nodeId, connectionGen);
  }

  // Note: No await here. This function returns immediately after enqueueing.
  // The actual downstream handler invocations happen in a future setImmediate.
}
