/**
 * segment-manager.ts
 *
 * WAL segment lifecycle manager implementing a sliding-window trim policy.
 *
 * Policy:
 *  - Retain the last N active segments where N = floor(WAL_DISK_QUOTA_GB * 1024 / 64).
 *    Default quota is 10 GB → N = floor(10240 / 64) = 160 segments.
 *  - Segments beyond the window are deleted regardless of watermark position,
 *    bounding disk usage even when watermark advancement is frozen during a
 *    network partition.
 *  - Segment rotation is triggered when the active segment reaches
 *    SEGMENT_SIZE_BYTES (64 MB).
 *
 * All filesystem I/O is injected through SegmentFs so the class is fully
 * unit-testable without touching the real disk.
 */

export const SEGMENT_SIZE_BYTES = 64 * 1024 * 1024; // 64 MB
export const DEFAULT_WAL_DISK_QUOTA_GB = 10;
export const SEGMENT_SIZE_MB = 64;

/** Minimal filesystem surface needed by SegmentManager. */
export interface SegmentFs {
  appendFile(path: string, data: Buffer): Promise<void>;
  deleteFile(path: string): Promise<void>;
  fileSize(path: string): Promise<number>;
  listFiles(dir: string): Promise<string[]>;
}

export interface SegmentInfo {
  /** Segment sequence number (monotonically increasing). */
  index: number;
  /** Absolute file path. */
  path: string;
  /** Current size in bytes as tracked in memory. */
  sizeBytes: number;
  /** Epoch-ms timestamp when this segment was created. */
  createdAt: number;
}

export interface SegmentManagerOptions {
  segmentDir: string;
  walDiskQuotaGb?: number;
  fs?: SegmentFs;
  clock?: () => number;
}

export class SegmentManager {
  private segments: SegmentInfo[] = [];
  private activeIndex: number = 0;

  private readonly segmentDir: string;
  private readonly maxSegments: number;
  private readonly fs: SegmentFs;
  private readonly clock: () => number;

  constructor(options: SegmentManagerOptions) {
    this.segmentDir = options.segmentDir;
    this.clock = options.clock ?? Date.now;

    const quotaGb = options.walDiskQuotaGb ?? DEFAULT_WAL_DISK_QUOTA_GB;
    this.maxSegments = Math.floor((quotaGb * 1024) / SEGMENT_SIZE_MB);

    this.fs = options.fs ?? this.buildDefaultFs();
  }

  getSegments(): readonly SegmentInfo[] {
    return this.segments;
  }

  getActiveSegment(): SegmentInfo {
    if (this.segments.length === 0) {
      this.createNewSegment();
    }
    return this.segments[this.segments.length - 1];
  }

  async rotate(): Promise<SegmentInfo> {
    this.createNewSegment();
    await this.trimWindow();
    return this.getActiveSegment();
  }

  /**
   * Records a write of byteCount bytes to the active segment.
   * Triggers rotation automatically when the segment reaches SEGMENT_SIZE_BYTES.
   * Returns true if a rotation occurred.
   */
  async recordWrite(byteCount: number): Promise<boolean> {
    const active = this.getActiveSegment();
    active.sizeBytes += byteCount;

    if (active.sizeBytes >= SEGMENT_SIZE_BYTES) {
      await this.rotate();
      return true;
    }
    return false;
  }

  /**
   * Explicitly removes a segment by index from the tracked list and deletes
   * its file. Called by ledger-sync-protocol after a segment has been archived.
   */
  async removeSegment(index: number): Promise<void> {
    const pos = this.segments.findIndex((s) => s.index === index);
    if (pos === -1) return;
    const [seg] = this.segments.splice(pos, 1);
    await this.fs.deleteFile(seg.path);
  }

  /**
   * Returns segments whose createdAt is older than ageMs milliseconds ago.
   * Used by the archive-spill logic in ledger-sync-protocol.
   */
  getSegmentsOlderThan(ageMs: number): SegmentInfo[] {
    const cutoff = this.clock() - ageMs;
    return this.segments.filter((s) => s.createdAt < cutoff);
  }

  getTotalBytes(): number {
    return this.segments.reduce((sum, s) => sum + s.sizeBytes, 0);
  }

  getMaxSegments(): number {
    return this.maxSegments;
  }

  segmentPath(index: number): string {
    return `${this.segmentDir}/wal-${String(index).padStart(10, '0')}.seg`;
  }

  // ─── private ────────────────────────────────────────────────────────────────

  private createNewSegment(): void {
    this.activeIndex += 1;
    this.segments.push({
      index: this.activeIndex,
      path: this.segmentPath(this.activeIndex),
      sizeBytes: 0,
      createdAt: this.clock(),
    });
  }

  private async trimWindow(): Promise<void> {
    while (this.segments.length > this.maxSegments) {
      const oldest = this.segments.shift()!;
      try {
        await this.fs.deleteFile(oldest.path);
      } catch {
        // Already removed by archive spill — not fatal.
      }
    }
  }

  private buildDefaultFs(): SegmentFs {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fsPromises = require('fs/promises') as typeof import('fs/promises');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePath = require('path') as typeof import('path');

    return {
      async appendFile(filePath, data) {
        const dir = nodePath.dirname(filePath);
        await fsPromises.mkdir(dir, { recursive: true });
        await fsPromises.appendFile(filePath, data);
      },
      async deleteFile(filePath) {
        try {
          await fsPromises.unlink(filePath);
        } catch (err: any) {
          if (err?.code !== 'ENOENT') throw err;
        }
      },
      async fileSize(filePath) {
        try {
          const stat = await fsPromises.stat(filePath);
          return stat.size;
        } catch {
          return 0;
        }
      },
      async listFiles(dir) {
        try {
          const entries = await fsPromises.readdir(dir);
          return entries.map((e) => nodePath.join(dir, e));
        } catch {
          return [];
        }
      },
    };
  }
}
