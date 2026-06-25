import { EventEmitter } from 'events';

/**
 * Active connection counter and monitoring.
 * 
 * Tracks connection count in real-time so lifecycle-manager can report
 * accurate drain progress to health probes.  Emits events when
 * thresholds are crossed so the proxy accept loop can stop accepting
 * new connections during shutdown.
 */

export interface ConnectionSnapshot {
  /** Current number of active connections. */
  active: number;
  /** Connections drained since shutdown began. */
  drained: number;
  /** Connections force-closed during phase 2. */
  forceClosed: number;
  /** Timestamp of the snapshot. */
  timestamp: number;
}

export class ConnectionTracker extends EventEmitter {
  private activeCount = 0;
  private drainedCount = 0;
  private forceClosedCount = 0;

  /** Max connections per node — matches invariant: 200,000. */
  private readonly maxConnections: number;

  constructor(maxConnections = 200_000) {
    super();
    this.maxConnections = maxConnections;
  }

  // ── tracking ───────────────────────────────────────────────────

  /** Called when a new connection is accepted. */
  onAccept(): void {
    this.activeCount++;
    if (this.activeCount >= this.maxConnections) {
      this.emit('capacity:reached', this.activeCount);
    }
    if (this.activeCount >= this.maxConnections * 0.9) {
      this.emit('capacity:warning', this.activeCount);
    }
  }

  /** Called when a connection is gracefully drained. */
  onDrain(): void {
    if (this.activeCount > 0) this.activeCount--;
    this.drainedCount++;
    this.emit('drain', this.activeCount);
    this.checkZero();
  }

  /** Called when a connection is force-closed (RST). */
  onForceClose(): void {
    if (this.activeCount > 0) this.activeCount--;
    this.forceClosedCount++;
    this.emit('force-close', this.activeCount);
    this.checkZero();
  }

  // ── queries ────────────────────────────────────────────────────

  snapshot(): ConnectionSnapshot {
    return {
      active: this.activeCount,
      drained: this.drainedCount,
      forceClosed: this.forceClosedCount,
      timestamp: Date.now(),
    };
  }

  get active(): number {
    return this.activeCount;
  }

  get drained(): number {
    return this.drainedCount;
  }

  get forceClosed(): number {
    return this.forceClosedCount;
  }

  get isIdle(): boolean {
    return this.activeCount === 0;
  }

  /** Bulk register N connections (used during startup re-count). */
  setActive(n: number): void {
    this.activeCount = n;
  }

  // ── private ────────────────────────────────────────────────────

  private checkZero(): void {
    if (this.activeCount === 0) {
      this.emit('all-drained');
    }
  }
}
