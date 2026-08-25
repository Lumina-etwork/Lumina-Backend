/**
 * ledger-sync-protocol.ts
 *
 * Inter-replica ledger synchronisation with ZSTD-compressed archive spill.
 *
 * During a network partition:
 *  - Segments older than ARCHIVE_SPILL_AGE_MS (5 minutes) are compressed with
 *    ZSTD at level 3 and moved to ARCHIVE_DIR, freeing active-WAL space.
 *
 * On partition heal:
 *  - All archives are replayed in LSN order before normal WAL operations resume.
 *  - Each archive entry is decompressed, decoded, and fed to the supplied
 *    `replayRecord` callback.
 *  - The AckWatermark is force-advanced after each archive is replayed.
 *
 * ZSTD is simulated via Node.js zlib (deflate/inflate) because the real `zstd`
 * native module requires a native build step. The interface, file naming, and
 * level semantics are identical — swap `compressZstd` / `decompressZstd` for
 * the real bindings in production.
 */

import { SegmentManager, SegmentInfo } from './segment-manager';
import { AckWatermark } from './ack-watermark';
import { EventEmitter } from 'events';

export const ARCHIVE_SPILL_AGE_MS = 5 * 60 * 1000; // 5 minutes
export const ZSTD_LEVEL = 3;

/** Minimal zlib surface injected for testability. */
export interface Compressor {
  compress(data: Buffer): Promise<Buffer>;
  decompress(data: Buffer): Promise<Buffer>;
}

/** Minimal filesystem surface for archive operations. */
export interface ArchiveFs {
  writeFile(path: string, data: Buffer): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  readSegment(path: string): Promise<Buffer>;
  deleteFile(path: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  ensureDir(dir: string): Promise<void>;
}

export interface ReplayRecord {
  lsn: bigint;
  payload: Buffer;
}

export interface LedgerSyncProtocolOptions {
  segmentManager: SegmentManager;
  watermark: AckWatermark;
  archiveDir: string;
  /** Called for each record during archive replay. */
  replayRecord: (record: ReplayRecord) => Promise<void>;
  compressor?: Compressor;
  fs?: ArchiveFs;
  clock?: () => number;
}

export class LedgerSyncProtocol extends EventEmitter {
  private readonly segmentManager: SegmentManager;
  private readonly watermark: AckWatermark;
  private readonly archiveDir: string;
  private readonly replayRecord: (record: ReplayRecord) => Promise<void>;
  private readonly compressor: Compressor;
  private readonly fs: ArchiveFs;
  private readonly clock: () => number;

  constructor(options: LedgerSyncProtocolOptions) {
    super();
    this.segmentManager = options.segmentManager;
    this.watermark = options.watermark;
    this.archiveDir = options.archiveDir;
    this.replayRecord = options.replayRecord;
    this.clock = options.clock ?? Date.now;
    this.compressor = options.compressor ?? this.buildDefaultCompressor();
    this.fs = options.fs ?? this.buildDefaultFs();
  }

  /**
   * Spill stale segments to the compressed archive directory.
   * Called periodically while in partition mode.
   *
   * Returns the number of segments archived.
   */
  async spillToArchive(): Promise<number> {
    const stale = this.segmentManager.getSegmentsOlderThan(ARCHIVE_SPILL_AGE_MS);
    if (stale.length === 0) return 0;

    await this.fs.ensureDir(this.archiveDir);
    let count = 0;

    for (const seg of stale) {
      try {
        await this.archiveSegment(seg);
        // Remove from active WAL window after successful archive.
        await this.segmentManager.removeSegment(seg.index);
        count += 1;
        this.emit('segmentArchived', seg.index);
      } catch (err) {
        // Log and continue — a single failed archive must not abort the loop.
        this.emit('archiveError', { segmentIndex: seg.index, error: err });
      }
    }

    return count;
  }

  /**
   * Replay all archived segments in ascending LSN order.
   * Called on partition heal before resuming normal WAL operations.
   *
   * Returns the highest LSN replayed (or 0n if no archives exist).
   */
  async replayFromArchive(): Promise<bigint> {
    const archivePaths = await this.fs.listFiles(this.archiveDir);
    const archives = archivePaths
      .filter((p) => p.endsWith('.wal.zst'))
      .sort(); // lexicographic sort on zero-padded index gives correct order

    if (archives.length === 0) return 0n;

    let highestLsn = 0n;

    for (const archivePath of archives) {
      try {
        const highLsn = await this.replayArchiveFile(archivePath);
        if (highLsn > highestLsn) highestLsn = highLsn;
        // Force watermark forward after each archive replayed.
        this.watermark.forceAdvance(highestLsn);
        this.emit('archiveReplayed', { path: archivePath, highLsn });
      } catch (err) {
        this.emit('replayError', { path: archivePath, error: err });
        throw err; // Abort replay on error — data integrity is paramount.
      }
    }

    return highestLsn;
  }

  // ─── private ────────────────────────────────────────────────────────────────

  private archiveName(segmentIndex: number): string {
    return `${this.archiveDir}/wal-${String(segmentIndex).padStart(10, '0')}.wal.zst`;
  }

  private async archiveSegment(seg: SegmentInfo): Promise<void> {
    const raw = await this.fs.readSegment(seg.path);
    const compressed = await this.compressor.compress(raw);
    await this.fs.writeFile(this.archiveName(seg.index), compressed);
  }

  /**
   * Decompresses and decodes a single archive file, replaying every record.
   * Frame format: [8-byte LSN BE][4-byte payload-length BE][payload bytes]
   */
  private async replayArchiveFile(archivePath: string): Promise<bigint> {
    const compressed = await this.fs.readFile(archivePath);
    const raw = await this.compressor.decompress(compressed);

    let offset = 0;
    let highestLsn = 0n;

    while (offset + 12 <= raw.length) {
      const lsn = raw.readBigUInt64BE(offset);
      const payloadLen = raw.readUInt32BE(offset + 8);
      offset += 12;

      if (offset + payloadLen > raw.length) break; // Truncated frame — stop.

      const payload = raw.slice(offset, offset + payloadLen);
      offset += payloadLen;

      await this.replayRecord({ lsn, payload });
      if (lsn > highestLsn) highestLsn = lsn;
    }

    return highestLsn;
  }

  private buildDefaultCompressor(): Compressor {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zlib = require('zlib') as typeof import('zlib');
    return {
      compress(data: Buffer): Promise<Buffer> {
        return new Promise((resolve, reject) =>
          zlib.deflate(data, { level: ZSTD_LEVEL }, (err, result) =>
            err ? reject(err) : resolve(result),
          ),
        );
      },
      decompress(data: Buffer): Promise<Buffer> {
        return new Promise((resolve, reject) =>
          zlib.inflate(data, (err, result) =>
            err ? reject(err) : resolve(result),
          ),
        );
      },
    };
  }

  private buildDefaultFs(): ArchiveFs {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fsPromises = require('fs/promises') as typeof import('fs/promises');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePath = require('path') as typeof import('path');

    return {
      async writeFile(p, data) { await fsPromises.writeFile(p, data); },
      async readFile(p) { return fsPromises.readFile(p); },
      async readSegment(p) {
        try { return await fsPromises.readFile(p); } catch { return Buffer.alloc(0); }
      },
      async deleteFile(p) {
        try { await fsPromises.unlink(p); } catch (e: any) {
          if (e?.code !== 'ENOENT') throw e;
        }
      },
      async listFiles(dir) {
        try {
          const entries = await fsPromises.readdir(dir);
          return entries.map((e) => nodePath.join(dir, e));
        } catch { return []; }
      },
      async ensureDir(dir) { await fsPromises.mkdir(dir, { recursive: true }); },
    };
  }
}
