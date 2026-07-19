const { Op } = require('sequelize');
const crypto = require('crypto');

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_CLAIM_LIMIT = 10;

class DistributedJobScheduler {
  constructor({ JobModel, sequelize, workerId, leaseMs = DEFAULT_LEASE_MS, clock = () => new Date(), metrics } = {}) {
    if (!JobModel) throw new Error('JobModel is required');
    if (!sequelize) throw new Error('sequelize is required');
    this.JobModel = JobModel;
    this.sequelize = sequelize;
    this.workerId = workerId || `${process.pid}-${crypto.randomUUID()}`;
    this.leaseMs = leaseMs;
    this.clock = clock;
    this.metrics = metrics;
  }

  async enqueue({ type, payload = {}, runAt, priority = 0, idempotencyKey }) {
    if (!type) throw new Error('type is required');
    const attrs = {
      type,
      payload,
      runAt: runAt || this.clock(),
      priority,
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      idempotencyKey,
    };
    if (idempotencyKey && this.JobModel.findOrCreate) {
      const [job] = await this.JobModel.findOrCreate({ where: { idempotencyKey }, defaults: attrs });
      return job;
    }
    return this.JobModel.create(attrs);
  }

  async claimNext({ types, limit = DEFAULT_CLAIM_LIMIT } = {}) {
    const now = this.clock();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
    const where = {
      runAt: { [Op.lte]: now },
      [Op.or]: [
        { status: 'queued' },
        { status: 'leased', leaseExpiresAt: { [Op.lt]: now } },
      ],
    };
    if (types?.length) where.type = { [Op.in]: types };

    return this.sequelize.transaction(async (transaction) => {
      const jobs = await this.JobModel.findAll({
        where,
        order: [['priority', 'DESC'], ['runAt', 'ASC'], ['id', 'ASC']],
        limit,
        transaction,
        lock: transaction.LOCK?.UPDATE,
        skipLocked: true,
      });
      await Promise.all(jobs.map((job) => job.update({
        status: 'leased',
        workerId: this.workerId,
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt,
        leasedAt: now,
      }, { transaction })));
      this.metrics?.claimed?.inc?.(jobs.length);
      return jobs;
    });
  }

  async heartbeat(job, { extendByMs = this.leaseMs } = {}) {
    const leaseExpiresAt = new Date(this.clock().getTime() + extendByMs);
    const [updated] = await this.JobModel.update(
      { leaseExpiresAt },
      { where: { id: job.id, workerId: this.workerId, leaseToken: job.leaseToken, status: 'leased' } }
    );
    if (updated !== 1) throw new Error('lease ownership lost');
    job.leaseExpiresAt = leaseExpiresAt;
    return job;
  }

  async complete(job, result = {}) {
    const [updated] = await this.JobModel.update(
      { status: 'completed', result, completedAt: this.clock() },
      { where: { id: job.id, workerId: this.workerId, leaseToken: job.leaseToken, status: 'leased' } }
    );
    if (updated !== 1) throw new Error('lease ownership lost');
    this.metrics?.completed?.inc?.();
  }

  async fail(job, error, { retryDelayMs = 60_000 } = {}) {
    const attempts = (job.attempts || 0) + 1;
    const exhausted = attempts >= (job.maxAttempts || 3);
    const [updated] = await this.JobModel.update({
      status: exhausted ? 'failed' : 'queued',
      attempts,
      lastError: error?.message || String(error),
      workerId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      runAt: exhausted ? job.runAt : new Date(this.clock().getTime() + retryDelayMs),
    }, { where: { id: job.id, workerId: this.workerId, leaseToken: job.leaseToken, status: 'leased' } });
    if (updated !== 1) throw new Error('lease ownership lost');
    this.metrics?.failed?.inc?.();
  }
}

module.exports = { DistributedJobScheduler, DEFAULT_LEASE_MS, DEFAULT_CLAIM_LIMIT };
