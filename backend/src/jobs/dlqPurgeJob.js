/**
 * DLQ Purge Job
 *
 * Issue #104: Dead Letter Queue for Failed Asynchronous Message Processing
 *
 * Runs daily at 03:00 AM and:
 *   1. Deletes dead_letter_queue rows older than 7 days from PostgreSQL.
 *   2. Creates the next day's partition (range-partitioned table) if it does
 *      not yet exist, so inserts never miss a partition.
 *
 * Usage (from app.js or a bootstrap module):
 *   const dlqPurgeJob = require('./jobs/dlqPurgeJob');
 *   dlqPurgeJob.start();
 */

const cron = require('node-cron');
const { sequelize } = require('../database/connection');

const DLQ_RETENTION_DAYS = 7;

class DlqPurgeJob {
  constructor(options = {}) {
    this.logger      = options.logger      || console;
    this.cronSchedule = options.cronSchedule || '0 3 * * *'; // 03:00 AM daily
    this.job          = null;
    this.isRunning    = false;
  }

  // -------------------------------------------------------------------------
  // start() — schedule the cron job (idempotent)
  // -------------------------------------------------------------------------
  start() {
    if (this.job) {
      this.logger.log('[DlqPurgeJob] Already running, skipping start()');
      return;
    }

    this.job = cron.schedule(this.cronSchedule, async () => {
      if (this.isRunning) {
        this.logger.log('[DlqPurgeJob] Previous run still active — skipping this tick');
        return;
      }
      await this.runOnce();
    }, { scheduled: false });

    this.job.start();
    this.logger.log('[DlqPurgeJob] Scheduled (daily at 03:00 AM)');
  }

  // -------------------------------------------------------------------------
  // stop() — cancel the cron job
  // -------------------------------------------------------------------------
  stop() {
    if (this.job) {
      this.job.stop();
      this.job = null;
      this.logger.log('[DlqPurgeJob] Stopped');
    }
  }

  // -------------------------------------------------------------------------
  // runOnce() — perform the purge + partition management in one pass.
  // Can be called manually for testing or from admin endpoints.
  // -------------------------------------------------------------------------
  async runOnce() {
    if (this.isRunning) {
      throw new Error('DlqPurgeJob is already running');
    }

    this.isRunning = true;
    const startedAt = new Date();

    try {
      this.logger.log('[DlqPurgeJob] Starting purge run…');

      const { deleted } = await this._purgeOldEntries();
      await this._ensureNextDayPartition();

      const durationMs = Date.now() - startedAt.getTime();
      this.logger.log(`[DlqPurgeJob] Completed — deleted ${deleted} row(s) in ${durationMs}ms`);
      return { deleted, durationMs };
    } catch (error) {
      this.logger.error('[DlqPurgeJob] Run failed:', error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  // -------------------------------------------------------------------------
  // _purgeOldEntries() — DELETE rows older than the retention window.
  // -------------------------------------------------------------------------
  async _purgeOldEntries() {
    const cutoff = new Date(
      Date.now() - DLQ_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    try {
      const [, meta] = await sequelize.query(
        'DELETE FROM dead_letter_queue WHERE created_at < :cutoff',
        { replacements: { cutoff } },
      );

      const deleted = meta?.rowCount ?? meta?.changes ?? 0;
      this.logger.log(`[DlqPurgeJob] Purged ${deleted} entries older than ${cutoff}`);
      return { deleted, cutoff };
    } catch (error) {
      // Table may not exist yet in test / fresh environments — log and continue.
      if (error.message && (error.message.includes('does not exist') || error.message.includes('no such table'))) {
        this.logger.log('[DlqPurgeJob] dead_letter_queue table not found — skipping purge');
        return { deleted: 0, cutoff };
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // _ensureNextDayPartition() — Create tomorrow's partition if absent.
  // This is only meaningful on a real PostgreSQL backend; on SQLite (test) we
  // skip silently.
  // -------------------------------------------------------------------------
  async _ensureNextDayPartition() {
    if (process.env.NODE_ENV === 'test') return;

    try {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const dateStr  = tomorrow.toISOString().slice(0, 10).replace(/-/g, '_');
      const partitionName = `dead_letter_queue_${dateStr}`;
      const startTs  = tomorrow.toISOString().slice(0, 10);
      const endTs    = new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      const [existing] = await sequelize.query(
        `SELECT 1 FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = :name AND n.nspname = current_schema()`,
        { replacements: { name: partitionName } },
      );

      if (!existing || existing.length === 0) {
        await sequelize.query(
          `CREATE TABLE IF NOT EXISTS "${partitionName}"
             PARTITION OF dead_letter_queue
             FOR VALUES FROM ('${startTs}') TO ('${endTs}')`,
        );
        this.logger.log(`[DlqPurgeJob] Created partition: ${partitionName}`);
      }
    } catch (error) {
      // Non-fatal — log and continue.
      this.logger.warn('[DlqPurgeJob] Could not ensure next-day partition:', error.message);
    }
  }
}

module.exports = new DlqPurgeJob();
