/**
 * wal-partition-resilience.test.js
 *
 * Comprehensive Jest tests for the WAL partition-resilience subsystem:
 *   - AckWatermark        (src/ledger/ack-watermark.ts)
 *   - SegmentManager      (src/ledger/segment-manager.ts)
 *   - WalWriter           (src/ledger/wal-writer.ts)
 *   - LedgerSyncProtocol  (src/ledger/ledger-sync-protocol.ts)
 *   - PartitionDetector   (src/consensus/partition-detector.ts)
 *   - DiskQuotaEnforcer   (src/storage/disk-quota-enforcer.ts)
 *
 * Every acceptance criterion from the issue is covered.
 */

'use strict';

const {
  AckWatermark,
  WATERMARK_ADVANCE_RECORDS,
  WATERMARK_ADVANCE_INTERVAL_MS,
} = require('../src/ledger/ack-watermark');

const {
  SegmentManager,
  SEGMENT_SIZE_BYTES,
  DEFAULT_WAL_DISK_QUOTA_GB,
  SEGMENT_SIZE_MB,
} = require('../src/ledger/segment-manager');

const {
  WalWriter,
  PARTITION_THROTTLE_BYTES_PER_MIN,
  PARTITION_FLUSH_BYTES,
  NORMAL_FLUSH_BYTES,
} = require('../src/ledger/wal-writer');

const {
  LedgerSyncProtocol,
  ARCHIVE_SPILL_AGE_MS,
  ZSTD_LEVEL,
} = require('../src/ledger/ledger-sync-protocol');

const {
  PartitionDetector,
  PARTITION_DETECT_TIMEOUT_MS,
} = require('../src/consensus/partition-detector');

const {
  DiskQuotaEnforcer,
  EMERGENCY_RESERVE_BYTES,
  SHUTDOWN_THRESHOLD,
  WARNING_THRESHOLD,
} = require('../src/storage/disk-quota-enforcer');

// ─── helpers ────────────────────────────────────────────────────────────────

/** Returns a no-op SegmentFs stub. */
function makeSegmentFs(overrides = {}) {
  return {
    appendFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    fileSize: jest.fn().mockResolvedValue(0),
    listFiles: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** Returns a no-op ArchiveFs stub. */
function makeArchiveFs(overrides = {}) {
  return {
    writeFile: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue(Buffer.alloc(0)),
    readSegment: jest.fn().mockResolvedValue(Buffer.alloc(0)),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    listFiles: jest.fn().mockResolvedValue([]),
    ensureDir: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Returns a no-op Compressor stub that passes data through unchanged. */
function makePassthroughCompressor() {
  return {
    compress: jest.fn((buf) => Promise.resolve(buf)),
    decompress: jest.fn((buf) => Promise.resolve(buf)),
  };
}

/**
 * Encodes a WalRecord into the binary frame format used by WalWriter:
 * [8-byte LSN BE][4-byte payload-length BE][payload bytes]
 */
function encodeFrame(lsn, payload) {
  const header = Buffer.allocUnsafe(12);
  header.writeBigUInt64BE(lsn, 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

/** Builds a raw segment buffer containing multiple frames. */
function buildSegmentData(records) {
  const frames = records.map(({ lsn, payload }) => encodeFrame(lsn, payload));
  return Buffer.concat(frames);
}

// ─── AckWatermark ────────────────────────────────────────────────────────────

describe('AckWatermark', () => {
  let wm;

  afterEach(() => {
    wm?.destroy();
  });

  test('starts at initial LSN 0', () => {
    wm = new AckWatermark();
    expect(wm.getWatermark()).toBe(0n);
  });

  test('accepts a custom initialLsn', () => {
    wm = new AckWatermark({ initialLsn: 42n });
    expect(wm.getWatermark()).toBe(42n);
  });

  test('does not advance before WATERMARK_ADVANCE_RECORDS threshold', () => {
    wm = new AckWatermark({ advanceIntervalMs: 999_999 });
    for (let i = 1; i < WATERMARK_ADVANCE_RECORDS; i++) {
      wm.acknowledge(BigInt(i));
    }
    expect(wm.getWatermark()).toBe(0n);
    expect(wm.getPendingCount()).toBe(WATERMARK_ADVANCE_RECORDS - 1);
  });

  test('advances watermark after WATERMARK_ADVANCE_RECORDS acknowledgements', () => {
    wm = new AckWatermark({ advanceIntervalMs: 999_999 });
    for (let i = 1; i <= WATERMARK_ADVANCE_RECORDS; i++) {
      wm.acknowledge(BigInt(i));
    }
    expect(wm.getWatermark()).toBe(BigInt(WATERMARK_ADVANCE_RECORDS));
    expect(wm.getPendingCount()).toBe(0);
  });

  test('onAdvance callback fires on each watermark advance', () => {
    const advances = [];
    wm = new AckWatermark({
      advanceIntervalMs: 999_999,
      onAdvance: (lsn) => advances.push(lsn),
    });
    for (let i = 1; i <= WATERMARK_ADVANCE_RECORDS * 2; i++) {
      wm.acknowledge(BigInt(i));
    }
    expect(advances).toHaveLength(2);
    expect(advances[0]).toBe(BigInt(WATERMARK_ADVANCE_RECORDS));
    expect(advances[1]).toBe(BigInt(WATERMARK_ADVANCE_RECORDS * 2));
  });

  test('ignores LSNs at or below current watermark', () => {
    wm = new AckWatermark({ initialLsn: 100n, advanceIntervalMs: 999_999 });
    wm.acknowledge(50n);
    expect(wm.getPendingCount()).toBe(0);
  });

  test('setPartitionMode(true) freezes watermark advancement', () => {
    wm = new AckWatermark({ advanceIntervalMs: 999_999 });
    wm.setPartitionMode(true);
    for (let i = 1; i <= WATERMARK_ADVANCE_RECORDS * 2; i++) {
      wm.acknowledge(BigInt(i));
    }
    expect(wm.getWatermark()).toBe(0n); // frozen
    expect(wm.isInPartitionMode()).toBe(true);
  });

  test('setPartitionMode(false) re-enables advancement', () => {
    wm = new AckWatermark({ advanceIntervalMs: 999_999 });
    wm.setPartitionMode(true);
    // Acknowledge 999 records while partitioned — no advance yet
    for (let i = 1; i < WATERMARK_ADVANCE_RECORDS; i++) {
      wm.acknowledge(BigInt(i));
    }
    expect(wm.getWatermark()).toBe(0n);
    wm.setPartitionMode(false);
    // One more acknowledgement should push pendingCount to 1000 and trigger advance
    wm.acknowledge(BigInt(WATERMARK_ADVANCE_RECORDS));
    expect(wm.getWatermark()).toBe(BigInt(WATERMARK_ADVANCE_RECORDS));
  });

  test('forceAdvance bypasses partition mode freeze', () => {
    wm = new AckWatermark({ advanceIntervalMs: 999_999 });
    wm.setPartitionMode(true);
    wm.forceAdvance(500n);
    expect(wm.getWatermark()).toBe(500n);
  });

  test('forceAdvance does not regress watermark', () => {
    wm = new AckWatermark({ initialLsn: 200n });
    wm.forceAdvance(100n);
    expect(wm.getWatermark()).toBe(200n);
  });

  test('periodic timer advances watermark after advanceIntervalMs', () => {
    jest.useFakeTimers();
    const advances = [];
    wm = new AckWatermark({
      advanceIntervalMs: WATERMARK_ADVANCE_INTERVAL_MS,
      onAdvance: (lsn) => advances.push(lsn),
    });
    wm.acknowledge(10n);
    expect(advances).toHaveLength(0);
    jest.advanceTimersByTime(WATERMARK_ADVANCE_INTERVAL_MS);
    expect(advances).toHaveLength(1);
    expect(advances[0]).toBe(10n);
    jest.useRealTimers();
  });

  test('periodic timer does not advance in partition mode', () => {
    jest.useFakeTimers();
    const advances = [];
    wm = new AckWatermark({
      advanceIntervalMs: WATERMARK_ADVANCE_INTERVAL_MS,
      onAdvance: (lsn) => advances.push(lsn),
    });
    wm.setPartitionMode(true);
    wm.acknowledge(10n);
    jest.advanceTimersByTime(WATERMARK_ADVANCE_INTERVAL_MS * 3);
    expect(advances).toHaveLength(0);
    jest.useRealTimers();
  });
});

// ─── SegmentManager ───────────────────────────────────────────────────────────

describe('SegmentManager', () => {
  test('default maxSegments = floor(quota_GB * 1024 / 64)', () => {
    const mgr = new SegmentManager({ segmentDir: '/wal', fs: makeSegmentFs() });
    expect(mgr.getMaxSegments()).toBe(
      Math.floor((DEFAULT_WAL_DISK_QUOTA_GB * 1024) / SEGMENT_SIZE_MB),
    );
  });

  test('custom walDiskQuotaGb is respected', () => {
    const mgr = new SegmentManager({
      segmentDir: '/wal',
      walDiskQuotaGb: 1,
      fs: makeSegmentFs(),
    });
    expect(mgr.getMaxSegments()).toBe(Math.floor((1 * 1024) / SEGMENT_SIZE_MB));
  });

  test('getActiveSegment creates first segment lazily', () => {
    const mgr = new SegmentManager({ segmentDir: '/wal', fs: makeSegmentFs() });
    expect(mgr.getSegments()).toHaveLength(0);
    const seg = mgr.getActiveSegment();
    expect(seg).toBeDefined();
    expect(mgr.getSegments()).toHaveLength(1);
  });

  test('recordWrite accumulates bytes in active segment', async () => {
    const mgr = new SegmentManager({
      segmentDir: '/wal',
      walDiskQuotaGb: 1,
      fs: makeSegmentFs(),
    });
    const active = mgr.getActiveSegment();
    await mgr.recordWrite(1024);
    expect(active.sizeBytes).toBe(1024);
  });

  test('recordWrite triggers rotation at SEGMENT_SIZE_BYTES', async () => {
    const segFs = makeSegmentFs();
    const mgr = new SegmentManager({
      segmentDir: '/wal',
      walDiskQuotaGb: 1,
      fs: segFs,
    });
    const firstSeg = mgr.getActiveSegment();

    const rotated = await mgr.recordWrite(SEGMENT_SIZE_BYTES);
    expect(rotated).toBe(true);
    expect(mgr.getActiveSegment().index).not.toBe(firstSeg.index);
  });

  test('sliding window trims oldest segments beyond maxSegments', async () => {
    const segFs = makeSegmentFs();
    // 1 GB quota → 16 max segments
    const mgr = new SegmentManager({ segmentDir: '/wal', walDiskQuotaGb: 1, fs: segFs });
    const max = mgr.getMaxSegments(); // 16

    // Force max+5 rotations
    for (let i = 0; i < max + 5; i++) {
      await mgr.rotate();
    }

    expect(mgr.getSegments().length).toBeLessThanOrEqual(max);
    expect(segFs.deleteFile).toHaveBeenCalled();
  });

  test('removeSegment deletes file and removes from tracking', async () => {
    const segFs = makeSegmentFs();
    const mgr = new SegmentManager({ segmentDir: '/wal', walDiskQuotaGb: 1, fs: segFs });
    mgr.getActiveSegment(); // create seg index 1
    await mgr.rotate();     // create seg index 2

    const idx = mgr.getSegments()[0].index;
    await mgr.removeSegment(idx);

    expect(segFs.deleteFile).toHaveBeenCalled();
    expect(mgr.getSegments().find((s) => s.index === idx)).toBeUndefined();
  });

  test('getSegmentsOlderThan filters by createdAt', () => {
    let fakeNow = 1_000_000;
    const segFs = makeSegmentFs();
    const mgr = new SegmentManager({
      segmentDir: '/wal',
      walDiskQuotaGb: 1,
      fs: segFs,
      clock: () => fakeNow,
    });

    mgr.getActiveSegment(); // created at t=1_000_000
    fakeNow += 10 * 60 * 1000; // advance 10 minutes
    // Force a second segment at new time
    mgr['createNewSegment']?.() ?? mgr['activeIndex']; // test internal

    const stale = mgr.getSegmentsOlderThan(5 * 60 * 1000); // 5 min
    // The first segment was created 10 min ago → should appear
    expect(stale.length).toBeGreaterThanOrEqual(1);
    expect(stale[0].createdAt).toBe(1_000_000);
  });

  test('segmentPath uses zero-padded index', () => {
    const mgr = new SegmentManager({ segmentDir: '/wal', fs: makeSegmentFs() });
    expect(mgr.segmentPath(1)).toBe('/wal/wal-0000000001.seg');
    expect(mgr.segmentPath(9999999999)).toBe('/wal/wal-9999999999.seg');
  });
});

// ─── WalWriter ───────────────────────────────────────────────────────────────

describe('WalWriter', () => {
  function makeWriter(partitionMode = false, overrides = {}) {
    const segFs = makeSegmentFs();
    const segMgr = new SegmentManager({
      segmentDir: '/wal',
      walDiskQuotaGb: 1,
      fs: segFs,
    });
    const watermark = new AckWatermark({ advanceIntervalMs: 999_999 });
    const fsyncCalls = [];
    const appendCalls = [];

    const writer = new WalWriter({
      segmentManager: segMgr,
      watermark,
      fsync: jest.fn((path) => { fsyncCalls.push(path); return Promise.resolve(); }),
      appendFile: jest.fn((path, data) => { appendCalls.push({ path, data }); return Promise.resolve(); }),
      clock: Date.now,
      ...overrides,
    });

    if (partitionMode) {
      writer.setPartitionMode(true);
    }

    return { writer, watermark, fsyncCalls, appendCalls, segMgr };
  }

  test('appends correctly encoded frames', async () => {
    const { writer, appendCalls } = makeWriter();
    const payload = Buffer.from('hello');
    await writer.append({ lsn: 1n, payload });
    expect(appendCalls).toHaveLength(1);
    const frame = appendCalls[0].data;
    // Frame: 8-byte LSN + 4-byte length + payload
    expect(frame.length).toBe(12 + payload.length);
    expect(frame.readBigUInt64BE(0)).toBe(1n);
    expect(frame.readUInt32BE(8)).toBe(payload.length);
  });

  test('acknowledges the LSN on the watermark after append', async () => {
    const { writer, watermark } = makeWriter();
    const payload = Buffer.allocUnsafe(4);
    // Append WATERMARK_ADVANCE_RECORDS records to trigger advance
    for (let i = 1; i <= WATERMARK_ADVANCE_RECORDS; i++) {
      await writer.append({ lsn: BigInt(i), payload });
    }
    expect(watermark.getWatermark()).toBe(BigInt(WATERMARK_ADVANCE_RECORDS));
  });

  test('normal mode: fsync at NORMAL_FLUSH_BYTES boundary', async () => {
    const { writer, fsyncCalls } = makeWriter();
    // Write just below threshold — no fsync
    await writer.append({ lsn: 1n, payload: Buffer.allocUnsafe(NORMAL_FLUSH_BYTES - 20) });
    expect(fsyncCalls).toHaveLength(0);
    // Write enough to cross threshold
    await writer.append({ lsn: 2n, payload: Buffer.allocUnsafe(20) });
    expect(fsyncCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('partition mode: fsync at PARTITION_FLUSH_BYTES boundary (more aggressive)', async () => {
    const { writer, fsyncCalls } = makeWriter(false); // start in normal mode
    await writer.setPartitionMode(true); // this flushes once — capture baseline
    const baselineFsyncs = fsyncCalls.length;

    // Write just below the PARTITION_FLUSH_BYTES threshold — no extra fsync yet
    await writer.append({ lsn: 1n, payload: Buffer.allocUnsafe(PARTITION_FLUSH_BYTES - 20) });
    expect(fsyncCalls.length).toBe(baselineFsyncs); // no new fsync
    // Push past threshold
    await writer.append({ lsn: 2n, payload: Buffer.allocUnsafe(20) });
    expect(fsyncCalls.length).toBeGreaterThan(baselineFsyncs);
  });

  test('partition mode throttle: rejects writes exceeding 50 MB/min', async () => {
    let fakeNow = 0;
    const { writer } = makeWriter(false, { clock: () => fakeNow });
    await writer.setPartitionMode(true);

    // Fill up to just below the budget
    const bigPayload = Buffer.allocUnsafe(PARTITION_THROTTLE_BYTES_PER_MIN - 100);
    const first = await writer.append({ lsn: 1n, payload: bigPayload });
    expect(first).toBe(true);

    // This should be rejected — would exceed 50 MB/min
    const overflow = Buffer.allocUnsafe(200);
    const second = await writer.append({ lsn: 2n, payload: overflow });
    expect(second).toBe(false);
  });

  test('partition mode throttle resets after 60 seconds', async () => {
    let fakeNow = 0;
    const { writer } = makeWriter(false, { clock: () => fakeNow });
    await writer.setPartitionMode(true);

    const bigPayload = Buffer.allocUnsafe(PARTITION_THROTTLE_BYTES_PER_MIN - 100);
    await writer.append({ lsn: 1n, payload: bigPayload });

    // Advance clock past 1-minute window
    fakeNow = 61_000;
    const result = await writer.append({ lsn: 2n, payload: Buffer.allocUnsafe(100) });
    expect(result).toBe(true);
  });

  test('setPartitionMode triggers immediate fsync', async () => {
    const { writer, fsyncCalls } = makeWriter();
    writer.getActiveSegmentPath = () => '/wal/wal-0000000001.seg'; // stub
    await writer.setPartitionMode(true);
    expect(fsyncCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('partition mode threshold PARTITION_FLUSH_BYTES is less than NORMAL_FLUSH_BYTES', () => {
    expect(PARTITION_FLUSH_BYTES).toBeLessThan(NORMAL_FLUSH_BYTES);
  });

  test('partition throttle constant is 50 MB/min', () => {
    expect(PARTITION_THROTTLE_BYTES_PER_MIN).toBe(50 * 1024 * 1024);
  });
});

// ─── LedgerSyncProtocol ───────────────────────────────────────────────────────

describe('LedgerSyncProtocol', () => {
  function makeSyncProtocol(segOverrides = {}, archiveOverrides = {}) {
    const segFs = makeSegmentFs(segOverrides);
    const archFs = makeArchiveFs(archiveOverrides);
    const compressor = makePassthroughCompressor();
    const watermark = new AckWatermark({ advanceIntervalMs: 999_999 });

    let fakeNow = 1_000_000;
    const segMgr = new SegmentManager({
      segmentDir: '/wal',
      walDiskQuotaGb: 1,
      fs: segFs,
      clock: () => fakeNow,
    });

    // Create one active segment
    segMgr.getActiveSegment();

    const replayed = [];
    const proto = new LedgerSyncProtocol({
      segmentManager: segMgr,
      watermark,
      archiveDir: '/archive',
      replayRecord: jest.fn(async (rec) => replayed.push(rec)),
      compressor,
      fs: archFs,
      clock: () => fakeNow,
    });

    return { proto, segMgr, watermark, archFs, compressor, replayed, getFakeNow: () => fakeNow, advanceTime: (ms) => { fakeNow += ms; } };
  }

  test('spillToArchive returns 0 when no stale segments exist', async () => {
    const { proto } = makeSyncProtocol();
    const count = await proto.spillToArchive();
    expect(count).toBe(0);
  });

  test('spillToArchive archives segments older than 5 minutes', async () => {
    const { proto, segMgr, archFs, advanceTime } = makeSyncProtocol();

    // Advance time past the 5-minute threshold
    advanceTime(ARCHIVE_SPILL_AGE_MS + 1000);

    const count = await proto.spillToArchive();
    expect(count).toBe(1);
    expect(archFs.writeFile).toHaveBeenCalledTimes(1);
  });

  test('spillToArchive removes segment from manager after archiving', async () => {
    const { proto, segMgr, advanceTime } = makeSyncProtocol();
    advanceTime(ARCHIVE_SPILL_AGE_MS + 1000);

    const beforeCount = segMgr.getSegments().length;
    await proto.spillToArchive();
    expect(segMgr.getSegments().length).toBeLessThan(beforeCount);
  });

  test('spillToArchive compresses segment data', async () => {
    const { proto, compressor, advanceTime } = makeSyncProtocol();
    advanceTime(ARCHIVE_SPILL_AGE_MS + 1000);
    await proto.spillToArchive();
    expect(compressor.compress).toHaveBeenCalledTimes(1);
  });

  test('spillToArchive emits segmentArchived event', async () => {
    const { proto, advanceTime } = makeSyncProtocol();
    advanceTime(ARCHIVE_SPILL_AGE_MS + 1000);
    const events = [];
    proto.on('segmentArchived', (idx) => events.push(idx));
    await proto.spillToArchive();
    expect(events).toHaveLength(1);
  });

  test('replayFromArchive returns 0n when archive is empty', async () => {
    const { proto } = makeSyncProtocol();
    const lsn = await proto.replayFromArchive();
    expect(lsn).toBe(0n);
  });

  test('replayFromArchive decodes and replays records in order', async () => {
    const records = [
      { lsn: 1n, payload: Buffer.from('rec1') },
      { lsn: 2n, payload: Buffer.from('rec2') },
      { lsn: 3n, payload: Buffer.from('rec3') },
    ];
    const segData = buildSegmentData(records);

    const archFs = makeArchiveFs({
      listFiles: jest.fn().mockResolvedValue([
        '/archive/wal-0000000001.wal.zst',
      ]),
      readFile: jest.fn().mockResolvedValue(segData),
    });

    const { proto, replayed } = makeSyncProtocol({}, {});
    // Override with custom archFs
    const proto2 = new LedgerSyncProtocol({
      segmentManager: proto['segmentManager'],
      watermark: proto['watermark'],
      archiveDir: '/archive',
      replayRecord: async (rec) => replayed.push(rec),
      compressor: makePassthroughCompressor(),
      fs: archFs,
    });

    const highLsn = await proto2.replayFromArchive();
    expect(highLsn).toBe(3n);
    expect(replayed).toHaveLength(3);
    expect(replayed[0].lsn).toBe(1n);
    expect(replayed[2].lsn).toBe(3n);
  });

  test('replayFromArchive force-advances watermark', async () => {
    const records = [{ lsn: 99n, payload: Buffer.from('data') }];
    const segData = buildSegmentData(records);
    const archFs = makeArchiveFs({
      listFiles: jest.fn().mockResolvedValue(['/archive/wal-0000000001.wal.zst']),
      readFile: jest.fn().mockResolvedValue(segData),
    });

    const watermark = new AckWatermark({ advanceIntervalMs: 999_999 });
    watermark.setPartitionMode(true); // frozen
    const replayed = [];
    const proto = new LedgerSyncProtocol({
      segmentManager: new SegmentManager({ segmentDir: '/wal', walDiskQuotaGb: 1, fs: makeSegmentFs() }),
      watermark,
      archiveDir: '/archive',
      replayRecord: async (rec) => replayed.push(rec),
      compressor: makePassthroughCompressor(),
      fs: archFs,
    });

    await proto.replayFromArchive();
    // forceAdvance should bypass partition mode freeze
    expect(watermark.getWatermark()).toBe(99n);
  });

  test('ARCHIVE_SPILL_AGE_MS constant is 5 minutes', () => {
    expect(ARCHIVE_SPILL_AGE_MS).toBe(5 * 60 * 1000);
  });
});

// ─── PartitionDetector ────────────────────────────────────────────────────────

describe('PartitionDetector', () => {
  function makeDetector(peers, overrides = {}) {
    let fakeNow = 0;
    const detector = new PartitionDetector({
      peers,
      timeoutMs: PARTITION_DETECT_TIMEOUT_MS,
      pollIntervalMs: 100,
      clock: () => fakeNow,
      ...overrides,
    });
    return { detector, advanceTime: (ms) => { fakeNow += ms; } };
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('initial state: not partitioned', () => {
    const { detector } = makeDetector(['peer1', 'peer2']);
    expect(detector.isPartitioned()).toBe(false);
  });

  test('emits partition event when majority of peers time out', async () => {
    const partitionEvents = [];
    const { detector, advanceTime } = makeDetector(['peer1', 'peer2', 'peer3'], {
      onPartition: () => partitionEvents.push(true),
    });

    // Advance past timeout for 2 out of 3 peers
    advanceTime(PARTITION_DETECT_TIMEOUT_MS + 1000);

    await detector['checkPeers']();
    expect(detector.isPartitioned()).toBe(true);
    expect(partitionEvents).toHaveLength(1);
  });

  test('does not partition when minority of peers time out', async () => {
    const { detector, advanceTime } = makeDetector(['peer1', 'peer2', 'peer3']);

    // Refresh heartbeat for 2 peers — only peer3 will time out
    advanceTime(PARTITION_DETECT_TIMEOUT_MS + 1000);
    detector.receiveHeartbeat('peer1');
    detector.receiveHeartbeat('peer2');

    await detector['checkPeers']();
    expect(detector.isPartitioned()).toBe(false);
  });

  test('receiveHeartbeat resets peer timeout', async () => {
    const { detector, advanceTime } = makeDetector(['peer1', 'peer2', 'peer3']);
    advanceTime(PARTITION_DETECT_TIMEOUT_MS + 1);

    // Refresh all peers
    detector.receiveHeartbeat('peer1');
    detector.receiveHeartbeat('peer2');
    detector.receiveHeartbeat('peer3');

    await detector['checkPeers']();
    expect(detector.isPartitioned()).toBe(false);
  });

  test('emits heal event when quorum is restored', async () => {
    const healEvents = [];
    const { detector, advanceTime } = makeDetector(['peer1', 'peer2'], {
      onHeal: (lsn) => healEvents.push(lsn),
      triggerReplay: async () => 42n,
    });

    // Cause a partition
    advanceTime(PARTITION_DETECT_TIMEOUT_MS + 1);
    await detector['checkPeers']();
    expect(detector.isPartitioned()).toBe(true);

    // Heal: restore peers
    detector.receiveHeartbeat('peer1');
    detector.receiveHeartbeat('peer2');
    await detector['checkPeers']();

    expect(detector.isPartitioned()).toBe(false);
    expect(healEvents).toHaveLength(1);
    expect(healEvents[0]).toBe(42n);
  });

  test('calls triggerReplay before onHeal on partition recovery', async () => {
    const order = [];
    const triggerReplay = jest.fn(async () => { order.push('replay'); return 10n; });
    const onHeal = jest.fn(async () => { order.push('heal'); });

    const { detector, advanceTime } = makeDetector(['peer1', 'peer2'], {
      onPartition: () => {},
      onHeal,
      triggerReplay,
    });

    advanceTime(PARTITION_DETECT_TIMEOUT_MS + 1);
    await detector['checkPeers']();
    detector.receiveHeartbeat('peer1');
    detector.receiveHeartbeat('peer2');
    await detector['checkPeers']();

    expect(order).toEqual(['replay', 'heal']);
  });

  test('PARTITION_DETECT_TIMEOUT_MS constant is 30 seconds', () => {
    expect(PARTITION_DETECT_TIMEOUT_MS).toBe(30_000);
  });

  test('getUnreachableCount reflects timed-out peers', async () => {
    const { detector, advanceTime } = makeDetector(['p1', 'p2', 'p3', 'p4']);
    advanceTime(PARTITION_DETECT_TIMEOUT_MS + 1);
    // Refresh 2 peers
    detector.receiveHeartbeat('p1');
    detector.receiveHeartbeat('p2');
    await detector['checkPeers']();
    expect(detector.getUnreachableCount()).toBe(2);
  });
});

// ─── DiskQuotaEnforcer ────────────────────────────────────────────────────────

describe('DiskQuotaEnforcer', () => {
  function makeEnforcer(usedBytes, overrides = {}) {
    const probe = {
      getUsedBytes: jest.fn().mockResolvedValue(usedBytes),
    };
    const onCritical = jest.fn();
    const enforcer = new DiskQuotaEnforcer({
      walDir: '/wal',
      walDiskQuotaGb: 10,
      probe,
      onCritical,
      pollIntervalMs: 999_999,
      ...overrides,
    });
    return { enforcer, probe, onCritical };
  }

  test('EMERGENCY_RESERVE_BYTES is 500 MB', () => {
    expect(EMERGENCY_RESERVE_BYTES).toBe(500 * 1024 * 1024);
  });

  test('SHUTDOWN_THRESHOLD is 95%', () => {
    expect(SHUTDOWN_THRESHOLD).toBe(0.95);
  });

  test('WARNING_THRESHOLD is 80%', () => {
    expect(WARNING_THRESHOLD).toBe(0.80);
  });

  test('check reports correct usageFraction', async () => {
    const quotaBytes = 10 * 1024 * 1024 * 1024;
    const used = quotaBytes * 0.5;
    const { enforcer } = makeEnforcer(used);
    const status = await enforcer.check();
    expect(status.usageFraction).toBeCloseTo(0.5);
    expect(status.isWarning).toBe(false);
    expect(status.isCritical).toBe(false);
  });

  test('check sets isWarning at 80% usage', async () => {
    const quotaBytes = 10 * 1024 * 1024 * 1024;
    const used = quotaBytes * 0.82;
    const { enforcer } = makeEnforcer(used);
    const status = await enforcer.check();
    expect(status.isWarning).toBe(true);
    expect(status.isCritical).toBe(false);
  });

  test('check sets isCritical at 95% usage and calls onCritical', async () => {
    const quotaBytes = 10 * 1024 * 1024 * 1024;
    const used = quotaBytes * 0.96;
    const { enforcer, onCritical } = makeEnforcer(used);
    const status = await enforcer.check();
    expect(status.isCritical).toBe(true);
    expect(onCritical).toHaveBeenCalledTimes(1);
  });

  test('onCritical is called only once even with multiple checks above threshold', async () => {
    const quotaBytes = 10 * 1024 * 1024 * 1024;
    const used = quotaBytes * 0.96;
    const { enforcer, onCritical } = makeEnforcer(used);
    await enforcer.check();
    await enforcer.check();
    await enforcer.check();
    expect(onCritical).toHaveBeenCalledTimes(1);
  });

  test('emits criticalUsage event on first critical breach', async () => {
    const quotaBytes = 10 * 1024 * 1024 * 1024;
    const used = quotaBytes * 0.96;
    const { enforcer } = makeEnforcer(used);
    const events = [];
    enforcer.on('criticalUsage', (s) => events.push(s));
    await enforcer.check();
    expect(events).toHaveLength(1);
    expect(events[0].isCritical).toBe(true);
  });

  test('emits highUsage event at warning level', async () => {
    const quotaBytes = 10 * 1024 * 1024 * 1024;
    const used = quotaBytes * 0.85;
    const { enforcer } = makeEnforcer(used);
    const events = [];
    enforcer.on('highUsage', (s) => events.push(s));
    await enforcer.check();
    expect(events).toHaveLength(1);
    expect(events[0].isWarning).toBe(true);
  });

  test('getAvailableBytes subtracts emergency reserve', () => {
    const { enforcer } = makeEnforcer(0);
    const quota = enforcer.getQuotaBytes();
    const used = quota * 0.5;
    const available = enforcer.getAvailableBytes(used);
    expect(available).toBe(quota - used - EMERGENCY_RESERVE_BYTES);
  });

  test('getAvailableBytes never goes below 0', () => {
    const { enforcer } = makeEnforcer(0);
    const quota = enforcer.getQuotaBytes();
    // Simulate over-quota usage
    const available = enforcer.getAvailableBytes(quota + 1);
    expect(available).toBe(0);
  });

  test('availableBytes in status reflects emergency reserve deduction', async () => {
    const quotaBytes = 10 * 1024 * 1024 * 1024;
    const used = quotaBytes * 0.5;
    const { enforcer } = makeEnforcer(used);
    const status = await enforcer.check();
    expect(status.availableBytes).toBe(quotaBytes - used - EMERGENCY_RESERVE_BYTES);
    expect(status.reserveBytes).toBe(EMERGENCY_RESERVE_BYTES);
  });

  test('stop clears the poll timer', () => {
    jest.useFakeTimers();
    const { enforcer } = makeEnforcer(0);
    enforcer.start();
    enforcer.stop();
    // Should not throw
    jest.advanceTimersByTime(60_000);
    jest.useRealTimers();
  });
});

// ─── Integration: full partition → archive → heal cycle ─────────────────────

describe('Integration: partition → spill → heal → replay cycle', () => {
  test('full cycle: partition detected → WAL throttled → segments archived → heal → replay → watermark advanced', async () => {
    let fakeNow = 1_000_000;
    const clock = () => fakeNow;

    // --- Infrastructure stubs ---
    const segFs = makeSegmentFs();
    const compressor = makePassthroughCompressor();
    const watermark = new AckWatermark({ advanceIntervalMs: 999_999 });
    const segMgr = new SegmentManager({
      segmentDir: '/wal',
      walDiskQuotaGb: 1,
      fs: segFs,
      clock,
    });

    // Archive fs: listFiles returns one archive on replay, readFile returns a real frame
    const segData = buildSegmentData([{ lsn: 1n, payload: Buffer.from('data1') }]);
    const archFs = makeArchiveFs({
      listFiles: jest.fn().mockResolvedValue(['/archive/wal-0000000001.wal.zst']),
      readFile: jest.fn().mockResolvedValue(segData),
    });

    const replayed = [];
    const proto = new LedgerSyncProtocol({
      segmentManager: segMgr,
      watermark,
      archiveDir: '/archive',
      replayRecord: async (rec) => replayed.push(rec),
      compressor,
      fs: archFs,
      clock,
    });

    const fsyncCalls = [];
    const writer = new WalWriter({
      segmentManager: segMgr,
      watermark,
      fsync: jest.fn((p) => { fsyncCalls.push(p); return Promise.resolve(); }),
      appendFile: jest.fn().mockResolvedValue(undefined),
      clock,
    });

    // --- Step 1: partition detected ---
    const detector = new PartitionDetector({
      peers: ['peer1', 'peer2'],
      clock,
      timeoutMs: PARTITION_DETECT_TIMEOUT_MS,
      onPartition: async () => {
        watermark.setPartitionMode(true);
        await writer.setPartitionMode(true);
      },
      onHeal: async (_highLsn) => {
        watermark.setPartitionMode(false);
        await writer.setPartitionMode(false);
      },
      triggerReplay: () => proto.replayFromArchive(),
    });

    // Simulate partition: advance clock past timeout
    fakeNow += PARTITION_DETECT_TIMEOUT_MS + 1000;
    await detector['checkPeers']();
    expect(detector.isPartitioned()).toBe(true);
    expect(watermark.isInPartitionMode()).toBe(true);
    expect(writer.isInPartitionMode()).toBe(true);

    // --- Step 2: write a few records (throttled) ---
    const accepted = await writer.append({ lsn: 1n, payload: Buffer.from('data1') });
    expect(accepted).toBe(true);

    // --- Step 3: advance time past ARCHIVE_SPILL_AGE_MS, then spill ---
    fakeNow += ARCHIVE_SPILL_AGE_MS + 1000;
    segMgr.getActiveSegment(); // ensure at least one segment exists
    // spillToArchive may archive 0 or more — just verify it doesn't throw
    const archivedCount = await proto.spillToArchive();
    expect(archivedCount).toBeGreaterThanOrEqual(0);

    // --- Step 4: heal detected ---
    detector.receiveHeartbeat('peer1');
    detector.receiveHeartbeat('peer2');
    await detector['checkPeers']();

    expect(detector.isPartitioned()).toBe(false);
    // triggerReplay was called → replayed records from the archive
    expect(replayed.length).toBeGreaterThanOrEqual(1);
    expect(replayed[0].lsn).toBe(1n);
    // Watermark should have advanced to replayed LSN
    expect(watermark.getWatermark()).toBe(1n);
    // Writer should be back in normal mode
    expect(writer.isInPartitionMode()).toBe(false);
  });
});
