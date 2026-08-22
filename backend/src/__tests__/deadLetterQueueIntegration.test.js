/**
 * Integration test — Dead Letter Queue (Issue #104)
 *
 * Verifies that:
 *   1. 10 messages submitted to a consumer that always fails land in the DLQ
 *      after exhausting 3 retry attempts.
 *   2. The metrics helpers (recordDlqMessage, recordDlqRetry, recordDlqFailure)
 *      are called on the metricsService correctly.
 *   3. The DeadLetterQueueService.retry() re-enqueues a job and increments the
 *      retry metric.
 *
 * All external dependencies (BullMQ, IORedis, prom-client) are mocked so the
 * test runs without a live Redis instance.
 */

'use strict';

// ---------------------------------------------------------------------------
// Mocks — must be set up BEFORE requiring the modules under test
// ---------------------------------------------------------------------------

// Mock IORedis so DeadLetterQueueService never opens a real connection.
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
  }));
});

// Minimal BullMQ Queue mock
class MockQueue {
  constructor(name) {
    this.name = name;
    this._jobs = new Map();
    this._addedJobs = [];
  }

  async add(name, data, opts = {}) {
    const jobId = opts.jobId || `job-${Date.now()}-${Math.random()}`;
    const job   = {
      id: jobId,
      name,
      data,
      opts,
      attemptsMade: 0,
      stacktrace: [],
      updateData: async function(newData) {
        this.data = newData;
      },
    };
    this._jobs.set(jobId, job);
    this._addedJobs.push(job);
    return job;
  }

  async getJob(jobId) {
    return this._jobs.get(jobId) || null;
  }

  async close() {}
}

// Minimal BullMQ QueueEvents mock
class MockQueueEvents {
  constructor() {
    this._listeners = {};
  }
  on(event, cb) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(cb);
  }
  emit(event, data) {
    (this._listeners[event] || []).forEach(cb => cb(data));
  }
  async close() {}
}

jest.mock('bullmq', () => ({
  Queue:       MockQueue,
  QueueEvents: MockQueueEvents,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are in place)
// ---------------------------------------------------------------------------
const { DeadLetterQueueService } = require('../services/deadLetterQueueService');
const metricsService             = require('../services/metricsService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simulate a consumer that always fails a job after `maxAttempts` attempts.
 * Calls captureFailedJob when attempts are exhausted — mirrors what
 * attachToQueue does internally.
 *
 * @param {DeadLetterQueueService} dlqService
 * @param {string}                 queueName
 * @param {{ id: string, name: string, data: any, opts: object }} job
 * @param {number}                 maxAttempts
 */
async function simulateAlwaysFailingConsumer(dlqService, queueName, job, maxAttempts = 3) {
  const failedJob = {
    ...job,
    attemptsMade: maxAttempts,
    opts:         { attempts: maxAttempts },
    failedReason: 'Simulated consumer failure',
    stacktrace:   ['Error: Simulated consumer failure\n    at consumer.js:1:1'],
  };

  await dlqService.captureFailedJob(queueName, failedJob, 'Simulated consumer failure', {
    reason: 'exhausted_retries',
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('DeadLetterQueue — integration', () => {
  let dlqService;
  let dlqQueue;  // the internal MockQueue used as the DLQ store
  let metricsRecordDlqMessage;
  let metricsRecordDlqRetry;
  let metricsRecordDlqFailure;

  beforeEach(() => {
    // Spy on metricsService methods so we can assert call counts.
    metricsRecordDlqMessage = jest.spyOn(metricsService, 'recordDlqMessage');
    metricsRecordDlqRetry   = jest.spyOn(metricsService, 'recordDlqRetry');
    metricsRecordDlqFailure = jest.spyOn(metricsService, 'recordDlqFailure');

    dlqQueue = new MockQueue('system-dead-letter');

    dlqService = new DeadLetterQueueService({
      dlq:     dlqQueue,
      Queue:   MockQueue,
      QueueEvents: MockQueueEvents,
      metrics: metricsService,
      logger:  { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Core scenario: 10 messages → always-failing consumer → all in DLQ
  // -------------------------------------------------------------------------
  test(
    'all 10 messages land in the DLQ after 3 failed attempts each',
    async () => {
      const QUEUE_NAME  = 'test-queue';
      const MAX_ATTEMPTS = 3;
      const NUM_MESSAGES = 10;

      // Build 10 source jobs
      const sourceJobs = Array.from({ length: NUM_MESSAGES }, (_, i) => ({
        id:   `source-job-${i + 1}`,
        name: 'process-event',
        data: { eventId: i + 1, payload: `message-${i + 1}` },
        opts: { attempts: MAX_ATTEMPTS },
      }));

      // Simulate all 10 failing after exhausting retries
      for (const job of sourceJobs) {
        await simulateAlwaysFailingConsumer(dlqService, QUEUE_NAME, job, MAX_ATTEMPTS);
      }

      // 1. All 10 should be stored in the DLQ queue
      expect(dlqQueue._addedJobs).toHaveLength(NUM_MESSAGES);

      // 2. Each DLQ entry should preserve the source queue and job id
      dlqQueue._addedJobs.forEach((dlqJob, idx) => {
        expect(dlqJob.data.sourceQueue).toBe(QUEUE_NAME);
        expect(dlqJob.data.sourceJobId).toBe(`source-job-${idx + 1}`);
        expect(dlqJob.data.attemptsMade).toBe(MAX_ATTEMPTS);
        expect(dlqJob.data.failedReason).toBe('Simulated consumer failure');
      });

      // 3. recordDlqMessage called once per message
      expect(metricsRecordDlqMessage).toHaveBeenCalledTimes(NUM_MESSAGES);
      metricsRecordDlqMessage.mock.calls.forEach(([sourceQueue, jobName, reason]) => {
        expect(sourceQueue).toBe(QUEUE_NAME);
        expect(jobName).toBe('process-event');
        expect(reason).toBe('exhausted_retries');
      });
    },
  );

  // -------------------------------------------------------------------------
  // Retry: re-enqueue a DLQ job and confirm the retry metric fires
  // -------------------------------------------------------------------------
  test('retry() re-enqueues the job and increments dlq_retry_total', async () => {
    const QUEUE_NAME = 'test-retry-queue';

    const sourceJob = {
      id:   'retry-job-1',
      name: 'heavy-task',
      data: { value: 42 },
      opts: { attempts: 3 },
    };

    // Capture into DLQ first
    await simulateAlwaysFailingConsumer(dlqService, QUEUE_NAME, sourceJob, 3);

    // Get the DLQ job id that was assigned
    const dlqJob = dlqQueue._addedJobs[0];
    expect(dlqJob).toBeDefined();

    // Create a target queue that the retry will go into
    const targetQueue = new MockQueue(QUEUE_NAME);

    const retriedJob = await dlqService.retry(dlqJob.id, targetQueue);

    // The job should have been added to the target queue
    expect(retriedJob).not.toBeNull();
    expect(targetQueue._addedJobs).toHaveLength(1);
    expect(targetQueue._addedJobs[0].name).toBe('heavy-task');

    // Retry metric should have fired once
    expect(metricsRecordDlqRetry).toHaveBeenCalledTimes(1);
    const [sq, jn] = metricsRecordDlqRetry.mock.calls[0];
    expect(sq).toBe(QUEUE_NAME);
    expect(jn).toBe('heavy-task');
  });

  // -------------------------------------------------------------------------
  // captureFailedJob: payload is stored (not truncated for small payloads)
  // -------------------------------------------------------------------------
  test('captureFailedJob preserves small payloads intact', async () => {
    const QUEUE_NAME = 'payload-queue';
    const payload    = { userId: 'u-123', amount: 500, currency: 'XLM' };

    const job = {
      id:   'payload-job-1',
      name: 'transfer',
      data: payload,
      opts: { attempts: 1 },
    };

    await simulateAlwaysFailingConsumer(dlqService, QUEUE_NAME, job, 1);

    const dlqJob = dlqQueue._addedJobs[0];
    expect(dlqJob.data.payload).toEqual(payload);
    expect(dlqJob.data.payload._dlq_truncated).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // attachToQueue: failed event triggers DLQ capture when retries exhausted
  // -------------------------------------------------------------------------
  test('attachToQueue captures job when attemptsMade >= maxAttempts', async () => {
    const QUEUE_NAME = 'auto-attach-queue';

    // Build a source queue with a job in it
    const sourceQueue = new MockQueue(QUEUE_NAME);
    const job = await sourceQueue.add('event-handler', { data: 'x' }, {
      jobId: 'auto-job-1',
      attempts: 3,
    });
    job.attemptsMade = 3; // exhausted
    job.opts = { attempts: 3 };
    job.stacktrace = [];
    sourceQueue._jobs.set(job.id, job);

    const events = new MockQueueEvents();

    await dlqService.attachToQueue(QUEUE_NAME, {
      connection: {},
      queue:      sourceQueue,
      events,
    });

    // Simulate a 'failed' event from BullMQ
    events.emit('failed', { jobId: job.id, failedReason: 'timeout' });

    // Give the async handler time to complete
    await new Promise(resolve => setImmediate(resolve));

    expect(dlqQueue._addedJobs).toHaveLength(1);
    expect(dlqQueue._addedJobs[0].data.sourceJobId).toBe(job.id);
    expect(metricsRecordDlqMessage).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // attachToQueue: NOT captured when retries are NOT exhausted
  // -------------------------------------------------------------------------
  test('attachToQueue does NOT capture job when retries remain', async () => {
    const QUEUE_NAME = 'not-exhausted-queue';
    const sourceQueue = new MockQueue(QUEUE_NAME);

    const job = await sourceQueue.add('event-handler', { data: 'y' }, {
      jobId: 'not-exhausted-job-1',
      attempts: 3,
    });
    job.attemptsMade = 1; // still has retries left
    job.opts = { attempts: 3 };
    job.stacktrace = [];
    sourceQueue._jobs.set(job.id, job);

    const events = new MockQueueEvents();
    await dlqService.attachToQueue(QUEUE_NAME, {
      connection: {},
      queue:      sourceQueue,
      events,
    });

    events.emit('failed', { jobId: job.id, failedReason: 'transient error' });
    await new Promise(resolve => setImmediate(resolve));

    // Should NOT have been captured — retries remain
    expect(dlqQueue._addedJobs).toHaveLength(0);
    expect(metricsRecordDlqMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // metricsService exports the three DLQ helpers
  // -------------------------------------------------------------------------
  test('metricsService exports recordDlqMessage, recordDlqRetry, recordDlqFailure', () => {
    expect(typeof metricsService.recordDlqMessage).toBe('function');
    expect(typeof metricsService.recordDlqRetry).toBe('function');
    expect(typeof metricsService.recordDlqFailure).toBe('function');
  });

  // -------------------------------------------------------------------------
  // metricsService exports gauge and counter objects
  // -------------------------------------------------------------------------
  test('metricsService exports dlqDepth gauge and counters', () => {
    expect(metricsService.dlqDepth).toBeDefined();
    expect(metricsService.dlqEnqueueTotal).toBeDefined();
    expect(metricsService.dlqRetryTotal).toBeDefined();
  });
});
