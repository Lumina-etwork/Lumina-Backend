const { Queue, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const crypto = require('crypto');
const metrics = require('./metricsService');

const DEFAULT_DLQ_NAME = 'system-dead-letter';
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_RETENTION_DAYS = 14;

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function sanitizeError(error) {
  if (!error) return null;
  const message = typeof error === 'string' ? error : error.message;
  return String(message || 'unknown error').slice(0, 2048);
}

function truncatePayload(data, maxPayloadBytes) {
  const serialized = JSON.stringify(data || {});
  if (Buffer.byteLength(serialized) <= maxPayloadBytes) return data || {};

  return {
    _dlq_truncated: true,
    _dlq_original_sha256: stableHash(data),
    _dlq_original_bytes: Buffer.byteLength(serialized),
  };
}

class DeadLetterQueueService {
  constructor(options = {}) {
    this.connection = options.connection;
    this.Queue = options.Queue || Queue;
    this.QueueEvents = options.QueueEvents || QueueEvents;
    this.logger = options.logger || console;
    this.metrics = options.metrics || metrics;
    this.dlqName = options.dlqName || process.env.DLQ_QUEUE_NAME || DEFAULT_DLQ_NAME;
    this.maxPayloadBytes = Number(options.maxPayloadBytes || process.env.DLQ_MAX_PAYLOAD_BYTES || DEFAULT_MAX_PAYLOAD_BYTES);
    this.retentionDays = Number(options.retentionDays || process.env.DLQ_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
    this.dlq = options.dlq || new this.Queue(this.dlqName, {
      connection: this.connection || new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null }),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: this.retentionDays * 24 * 60 * 60 },
        removeOnFail: false,
      },
    });
    this.listeners = [];
  }

  async captureFailedJob(sourceQueueName, job, error, context = {}) {
    const failedAt = new Date().toISOString();
    const entry = {
      sourceQueue: sourceQueueName,
      sourceJobId: String(job.id),
      sourceJobName: job.name,
      attemptsMade: job.attemptsMade || 0,
      maxAttempts: job.opts && job.opts.attempts,
      failedReason: sanitizeError(error || job.failedReason),
      stacktrace: Array.isArray(job.stacktrace) ? job.stacktrace.slice(-3) : [],
      payload: truncatePayload(job.data, this.maxPayloadBytes),
      payloadHash: stableHash(job.data),
      failedAt,
      context,
    };

    const dlqJobId = `${sourceQueueName}:${job.id}:${entry.payloadHash}`;
    const dlqJob = await this.dlq.add('failed-message', entry, { jobId: dlqJobId });
    this.metrics.recordDlqMessage(sourceQueueName, job.name || 'unknown', context.reason || 'exhausted_retries');
    this.logger.warn('Moved failed message to DLQ', { sourceQueueName, sourceJobId: job.id, dlqJobId });
    return dlqJob;
  }

  async attachToQueue(queueName, options = {}) {
    const connection = options.connection || this.connection;
    const events = options.events || new this.QueueEvents(queueName, { connection });
    events.on('failed', async ({ jobId, failedReason }) => {
      try {
        const queue = options.queue || new this.Queue(queueName, { connection });
        const job = await queue.getJob(jobId);
        if (!job) return;
        const maxAttempts = job.opts && job.opts.attempts ? job.opts.attempts : 1;
        if ((job.attemptsMade || 0) >= maxAttempts) {
          await this.captureFailedJob(queueName, job, failedReason, { reason: 'exhausted_retries' });
        }
      } catch (error) {
        this.metrics.recordDlqFailure(queueName, 'capture_error');
        this.logger.error('Unable to capture failed job for DLQ', { queueName, jobId, error: error.message });
      }
    });
    this.listeners.push(events);
    return events;
  }

  async retry(dlqJobId, targetQueue) {
    const dlqJob = await this.dlq.getJob(dlqJobId);
    if (!dlqJob) return null;
    const target = targetQueue || new this.Queue(dlqJob.data.sourceQueue, { connection: this.connection });
    const retried = await target.add(dlqJob.data.sourceJobName, dlqJob.data.payload, {
      jobId: `dlq-retry:${dlqJob.data.sourceQueue}:${dlqJob.data.sourceJobId}:${Date.now()}`,
    });
    await dlqJob.updateData({ ...dlqJob.data, retriedAt: new Date().toISOString(), retriedJobId: retried.id });
    this.metrics.recordDlqRetry(dlqJob.data.sourceQueue, dlqJob.data.sourceJobName || 'unknown');
    return retried;
  }

  async close() {
    await Promise.all(this.listeners.map((listener) => listener.close && listener.close()));
    if (this.dlq && this.dlq.close) await this.dlq.close();
  }
}

module.exports = { DeadLetterQueueService, truncatePayload, stableHash, DEFAULT_DLQ_NAME };
