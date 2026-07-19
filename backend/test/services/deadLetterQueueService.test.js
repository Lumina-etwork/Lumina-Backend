const { DeadLetterQueueService, truncatePayload, stableHash } = require('../../src/services/deadLetterQueueService');

function createMetrics() {
  return {
    recordDlqMessage: jest.fn(),
    recordDlqFailure: jest.fn(),
    recordDlqRetry: jest.fn(),
  };
}

describe('DeadLetterQueueService', () => {
  test('truncates oversized payloads without storing original content', () => {
    const payload = { secret: 'x'.repeat(100) };
    const truncated = truncatePayload(payload, 20);

    expect(truncated._dlq_truncated).toBe(true);
    expect(truncated._dlq_original_sha256).toBe(stableHash(payload));
    expect(truncated.secret).toBeUndefined();
  });

  test('captures exhausted failed jobs in the DLQ with stable id and metrics', async () => {
    const add = jest.fn().mockResolvedValue({ id: 'dlq-job' });
    const metrics = createMetrics();
    const service = new DeadLetterQueueService({
      dlq: { add },
      metrics,
      logger: { warn: jest.fn(), error: jest.fn() },
      maxPayloadBytes: 1024,
    });
    const job = {
      id: '42',
      name: 'send-email',
      data: { userId: 'u1' },
      attemptsMade: 3,
      opts: { attempts: 3 },
      stacktrace: ['one', 'two', 'three', 'four'],
    };

    await service.captureFailedJob('notifications', job, new Error('SMTP down'));

    expect(add).toHaveBeenCalledWith(
      'failed-message',
      expect.objectContaining({
        sourceQueue: 'notifications',
        sourceJobId: '42',
        failedReason: 'SMTP down',
        stacktrace: ['two', 'three', 'four'],
        payload: { userId: 'u1' },
      }),
      expect.objectContaining({ jobId: `notifications:42:${stableHash(job.data)}` })
    );
    expect(metrics.recordDlqMessage).toHaveBeenCalledWith('notifications', 'send-email', 'exhausted_retries');
  });

  test('replays a DLQ job to its source queue and annotates replay metadata', async () => {
    const updateData = jest.fn();
    const dlq = {
      getJob: jest.fn().mockResolvedValue({
        data: { sourceQueue: 'exports', sourceJobId: '7', sourceJobName: 'csv', payload: { vaultId: 'v1' } },
        updateData,
      }),
    };
    const targetQueue = { add: jest.fn().mockResolvedValue({ id: 'retry-1' }) };
    const metrics = createMetrics();
    const service = new DeadLetterQueueService({ dlq, metrics, logger: console });

    const retried = await service.retry('dlq-1', targetQueue);

    expect(retried).toEqual({ id: 'retry-1' });
    expect(targetQueue.add).toHaveBeenCalledWith('csv', { vaultId: 'v1' }, expect.objectContaining({ jobId: expect.stringMatching(/^dlq-retry:exports:7:/) }));
    expect(updateData).toHaveBeenCalledWith(expect.objectContaining({ retriedJobId: 'retry-1' }));
    expect(metrics.recordDlqRetry).toHaveBeenCalledWith('exports', 'csv');
  });
});
