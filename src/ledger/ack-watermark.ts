/**
 * ack-watermark.ts
 *
 * Acknowledged LSN (Log Sequence Number) watermark tracker for the WAL ledger.
 *
 * Advances the watermark either:
 *  - every WATERMARK_ADVANCE_RECORDS records acknowledged, or
 *  - every WATERMARK_ADVANCE_INTERVAL_MS milliseconds,
 * whichever comes first, matching the technical invariant of "every 1000 records
 * or 5 seconds".
 *
 * During a network partition the consensus quorum is unavailable, so watermark
 * advancement must be blocked to avoid acknowledging records that have not been
 * replicated. The `setPartitionMode(true)` method freezes advancement.
 */

export const WATERMARK_ADVANCE_RECORDS = 1_000;
export const WATERMARK_ADVANCE_INTERVAL_MS = 5_000;

export type WatermarkAdvanceCallback = (lsn: bigint) => void | Promise<void>;

export interface AckWatermarkOptions {
  /** Starting LSN (default 0n). */
  initialLsn?: bigint;
  /** Records between forced advances (default 1000). */
  advanceRecords?: number;
  /** Maximum ms between forced advances (default 5000). */
  advanceIntervalMs?: number;
  /** Callback invoked every time the watermark is advanced. */
  onAdvance?: WatermarkAdvanceCallback;
}

export class AckWatermark {
  private watermark: bigint;
  private pendingLsn: bigint;
  private pendingCount: number;
  private partitionMode: boolean;
  private advanceTimer: ReturnType<typeof setInterval> | null;

  private readonly advanceRecords: number;
  private readonly advanceIntervalMs: number;
  private readonly onAdvance: WatermarkAdvanceCallback | undefined;

  constructor(options: AckWatermarkOptions = {}) {
    this.watermark = options.initialLsn ?? 0n;
    this.pendingLsn = this.watermark;
    this.pendingCount = 0;
    this.partitionMode = false;
    this.advanceTimer = null;

    this.advanceRecords = options.advanceRecords ?? WATERMARK_ADVANCE_RECORDS;
    this.advanceIntervalMs = options.advanceIntervalMs ?? WATERMARK_ADVANCE_INTERVAL_MS;
    this.onAdvance = options.onAdvance;

    this.startTimer();
  }

  /**
   * Returns the last durably acknowledged LSN.
   */
  getWatermark(): bigint {
    return this.watermark;
  }

  /**
   * Acknowledges a record at the given LSN.
   * If the record count threshold is reached and we are not in partition mode,
   * the watermark advances immediately.
   */
  acknowledge(lsn: bigint): void {
    if (lsn <= this.watermark) {
      // Already below or at watermark — nothing to do.
      return;
    }

    if (lsn > this.pendingLsn) {
      this.pendingLsn = lsn;
    }

    this.pendingCount += 1;

    if (!this.partitionMode && this.pendingCount >= this.advanceRecords) {
      this.advanceWatermark();
    }
  }

  /**
   * Manually advance the watermark to `lsn` (used during partition-heal replay).
   * Bypasses the record-count check so replayed segments can catch up quickly.
   */
  forceAdvance(lsn: bigint): void {
    if (lsn > this.watermark) {
      this.watermark = lsn;
      this.pendingLsn = lsn;
      this.pendingCount = 0;
      this.onAdvance?.(this.watermark);
    }
  }

  /**
   * Enable or disable partition mode.
   * In partition mode the watermark will NOT advance, preventing false
   * acknowledgements from being written while the replica set is unreachable.
   */
  setPartitionMode(active: boolean): void {
    this.partitionMode = active;
  }

  isInPartitionMode(): boolean {
    return this.partitionMode;
  }

  /**
   * Returns the highest LSN that has been seen but not yet made durable.
   */
  getPendingLsn(): bigint {
    return this.pendingLsn;
  }

  /**
   * Returns the number of records acknowledged since the last watermark advance.
   */
  getPendingCount(): number {
    return this.pendingCount;
  }

  /**
   * Stop the periodic timer. Must be called on shutdown to avoid leaking the
   * interval handle.
   */
  destroy(): void {
    if (this.advanceTimer !== null) {
      clearInterval(this.advanceTimer);
      this.advanceTimer = null;
    }
  }

  // ─── private ────────────────────────────────────────────────────────────────

  private advanceWatermark(): void {
    if (this.pendingLsn <= this.watermark) return;

    this.watermark = this.pendingLsn;
    this.pendingCount = 0;
    this.onAdvance?.(this.watermark);
  }

  private startTimer(): void {
    const timer = setInterval(() => {
      if (!this.partitionMode && this.pendingCount > 0) {
        this.advanceWatermark();
      }
    }, this.advanceIntervalMs);

    // Allow the Node.js event loop to exit even while this timer is active.
    timer.unref?.();
    this.advanceTimer = timer;
  }
}
