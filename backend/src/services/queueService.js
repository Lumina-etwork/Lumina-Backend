const { Queue } = require('bullmq');
const ioredis = require('ioredis');
const { DeadLetterQueueService } = require('./deadLetterQueueService');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new ioredis(REDIS_URL, {
  maxRetriesPerRequest: null
});

const deadLetterQueueService = new DeadLetterQueueService({ connection });

const heavyComputationQueue = new Queue('heavy-computation', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: true,
  }
});

deadLetterQueueService.attachToQueue('heavy-computation', { queue: heavyComputationQueue, connection });

class QueueService {
  async addGenerateCsvJob(vaultId) {
    return await heavyComputationQueue.add('generate-csv', {
      type: 'CSV',
      vaultId
    });
  }

  async getJobStatus(jobId) {
    const job = await heavyComputationQueue.getJob(jobId);
    if (!job) return null;
    return {
      id: job.id,
      state: await job.getState(),
      progress: job.progress,
      result: job.returnvalue
    };
  }

  async retryDeadLetterJob(jobId) {
    return deadLetterQueueService.retry(jobId, heavyComputationQueue);
  }
}

const queueService = new QueueService();
queueService.deadLetterQueueService = deadLetterQueueService;

module.exports = queueService;
