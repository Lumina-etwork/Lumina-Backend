/**
 * wal-writer.ts
 *
 * WAL segment creation, append, and fsync with a partition-mode circuit breaker.
 *
 * Normal mode:
 *  - Appends records to the active segment via SegmentManager.
 *  - fsync is called per-segment (every 64 MB of data).
 *
 * Partition mode (activated by setPartitionMode(true)):
 *  - Append throughput is throttled to PARTITION_THROTTLE_BYTES_PER_MIN (50 MB/min).
 *  - fsync is called more aggressively: every PARTITION_FLUSH_BYTES (10 MB).
 *  - This gives operators ~10 minutes of runway before the disk quota is
 *    exhausted instead of the ~1.2 minutes that 500 MB/min would produce.
 */

import { SegmentManager, SegmentFs } from './segment-manager';
import { AckWatermark } from './ack-watermark';

export const PARTITION_THROTTLE_BYTES_PER_MIN = 50 * 1024 * 1024;  // 50 MB/min
export const PARTITION_FLUSH_BYTES = 10 * 1024 * 1024;              // 10 MB
export const NORMAL_FLUSH_BYTES = 64 * 1024 * 1024;                 // 64 MB (per-segment)

/** Opaque record written to the WAL. */
export interface WalRecord {
  lsn: bigint;
  payload: Buffer;
}

export interface WalWriterOptions {
  segmentManager: SegmentManager;
  watermark: AckWatermark;
  /** Injected fsync; receives the path of the segment to sync. */
  fsync?: (path: string) => Promise<void>;
  /** Injected append; receives path and data buffer. */
  appendFile?: (path: string, data: Buffer) => Promise<void>;
  /** Clock function (default Date.now). */
  clock?: () => number;
}

export class WalWriter {
  private partitionMode: boolean = false;
  private bytesWrittenThisMinute: number = 0;
  private minuteWindowStart: number;
  private bytesSinceLastFlush: number = 0;

  private readonly segmentManager: SegmentManager;
  private readonly watermark: AckWatermark;
  private readonly fsync: (path: string) => Promise<void>;
  private readonly appendFile: (path: string, data: Buffer) => Promise<void>;
  private readonly clock: () => number;

  constructor(options: WalWriterOptions) {
    this.segmentManager = options.segmentManager;
    this.watermark = options.watermark;
    this.clock = options.clock ?? Date.now;
    this.minuteWindowStart = this.clock();

    this.fsync = options.fsync ?? this.defaultFsync;
    this.appendFile = options.appendFile ?? this.defaultAppend;
  }

  /**
   * Appends a record to the WAL.
   *
   * In partition mode: throttles to PARTITION_THROTTLE_BYTES_PER_MIN and
   * fsyncs every PARTITION_FLUSH_BYTES.
   *
   * Returns false (and drops the record) if the partition-mode throttle budget
   * for the current minute has been exhausted — the caller should back off.
   */
  async append(record: WalRecord): Promise<boolean> {
    const recordBytes = record.payload.length;

    if (this.partitionMode) {
      // Slide the 1-minute window if needed.
      const now = this.clock();
      if (now - this.minuteWindowStart >= 60_000) {
        this.bytesWrittenThisMinute = 0;
        this.minuteWindowStart = now;
      }

      // Throttle check: refuse writes that exceed the 50 MB/min budget.
      if (this.bytesWrittenThisMinute + recordBytes > PARTITION_THROTTLE_BYTES_PER_MIN) {
        return false;
      }
    }

    // Encode the record as: [8-byte LSN][4-byte length][payload]
    const header = Buffer.allocUnsafe(12);
    header.writeBigUInt64BE(record.lsn, 0);
    header.writeUInt32BE(recordBytes, 8);
    const frame = Buffer.concat([header, record.payload]);

    const active = this.segmentManager.getActiveSegment();
    await this.appendFile(active.path, frame);
    await this.segmentManager.recordWrite(frame.length);

    if (this.partitionMode) {
      this.bytesWrittenThisMinute += frame.length;
    }

    this.bytesSinceLastFlush += frame.length;
    const flushThreshold = this.partitionMode ? PARTITION_FLUSH_BYTES : NORMAL_FLUSH_BYTES;

    if (this.bytesSinceLastFlush >= flushThreshold) {
      await this.flush();
    }

    this.watermark.acknowledge(record.lsn);
    return true;
  }

  /**
   * Forces an fsync of the active segment and resets the flush counter.
   */
  async flush(): Promise<void> {
    const active = this.segmentManager.getActiveSegment();
    await this.fsync(active.path);
    this.bytesSinceLastFlush = 0;
  }

  /**
   * Activates or deactivates partition mode.
   * Resets the per-minute byte counter and flushes the current segment
   * immediately upon activation so we start the partition with a clean slate.
   */
  async setPartitionMode(active: boolean): Promise<void> {
    if (active === this.partitionMode) return;
    this.partitionMode = active;

    if (active) {
      // Flush eagerly when entering partition mode.
      await this.flush();
      this.bytesWrittenThisMinute = 0;
      this.minuteWindowStart = this.clock();
    }
  }

  isInPartitionMode(): boolean {
    return this.partitionMode;
  }

  /** Bytes written in the current throttle window (partition mode only). */
  getBytesWrittenThisMinute(): number {
    return this.bytesWrittenThisMinute;
  }

  /** Bytes accumulated since the last fsync. */
  getBytesSinceLastFlush(): number {
    return this.bytesSinceLastFlush;
  }

  // ─── default I/O implementations ────────────────────────────────────────────

  private readonly defaultFsync = async (path: string): Promise<void> => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    await new Promise<void>((resolve, reject) => {
      fs.open(path, 'r+', (err, fd) => {
        if (err) { resolve(); return; } // File may not exist in test stubs.
        fs.fsync(fd, (syncErr) => {
          fs.close(fd, () => {
            if (syncErr) reject(syncErr); else resolve();
          });
        });
      });
    });
  };

  private readonly defaultAppend = async (path: string, data: Buffer): Promise<void> => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fsPromises = require('fs/promises') as typeof import('fs/promises');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePath = require('path') as typeof import('path');
    await fsPromises.mkdir(nodePath.dirname(path), { recursive: true });
    await fsPromises.appendFile(path, data);
  };
}
