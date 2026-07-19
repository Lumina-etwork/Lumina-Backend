const { DistributedJobScheduler } = require('../src/scheduler/distributedJobScheduler');

describe('DistributedJobScheduler', () => {
  const now = new Date('2026-07-19T00:00:00.000Z');

  test('claims due queued jobs using a transactional lease', async () => {
    const updated = [];
    const job = { id: 'job-1', update: jest.fn(async (attrs) => { updated.push(attrs); Object.assign(job, attrs); }) };
    const JobModel = { findAll: jest.fn(async () => [job]) };
    const sequelize = { transaction: jest.fn((fn) => fn({ LOCK: { UPDATE: 'UPDATE' } })) };
    const scheduler = new DistributedJobScheduler({ JobModel, sequelize, workerId: 'worker-a', leaseMs: 5000, clock: () => now });

    const jobs = await scheduler.claimNext({ limit: 1 });

    expect(jobs).toEqual([job]);
    expect(sequelize.transaction).toHaveBeenCalledTimes(1);
    expect(JobModel.findAll).toHaveBeenCalledWith(expect.objectContaining({ limit: 1, skipLocked: true }));
    expect(updated[0]).toMatchObject({ status: 'leased', workerId: 'worker-a', leaseExpiresAt: new Date(now.getTime() + 5000), leasedAt: now });
    expect(updated[0].leaseToken).toEqual(expect.any(String));
  });

  test('heartbeat and completion require the current lease token', async () => {
    const JobModel = { update: jest.fn(async () => [1]) };
    const scheduler = new DistributedJobScheduler({ JobModel, sequelize: { transaction: jest.fn() }, workerId: 'worker-a', clock: () => now });
    const job = { id: 'job-1', leaseToken: 'token-1' };

    await scheduler.heartbeat(job);
    await scheduler.complete(job, { ok: true });

    expect(JobModel.update).toHaveBeenNthCalledWith(1, expect.any(Object), { where: { id: 'job-1', workerId: 'worker-a', leaseToken: 'token-1', status: 'leased' } });
    expect(JobModel.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: 'completed', result: { ok: true } }), { where: { id: 'job-1', workerId: 'worker-a', leaseToken: 'token-1', status: 'leased' } });
  });

  test('requeues failed jobs until max attempts is reached', async () => {
    const JobModel = { update: jest.fn(async () => [1]) };
    const scheduler = new DistributedJobScheduler({ JobModel, sequelize: { transaction: jest.fn() }, workerId: 'worker-a', clock: () => now });

    await scheduler.fail({ id: 'job-1', leaseToken: 'token-1', attempts: 1, maxAttempts: 3, runAt: now }, new Error('boom'), { retryDelayMs: 1000 });
    await scheduler.fail({ id: 'job-2', leaseToken: 'token-2', attempts: 2, maxAttempts: 3, runAt: now }, new Error('boom'));

    expect(JobModel.update).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'queued', attempts: 2, workerId: null, leaseToken: null }), expect.any(Object));
    expect(JobModel.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: 'failed', attempts: 3, workerId: null, leaseToken: null }), expect.any(Object));
  });
});
