/**
 * SlowQueryCollector - Captures slow queries from pg_stat_statements
 * and PostgreSQL auto_explain logs.
 *
 * Issue #49: PostgreSQL Query Performance Monitoring and Slow Query Alerting
 *
 * Sampling interval: 60s (pg_stat_statements)
 * log_min_duration: 200ms (auto_explain)
 */

const { sequelize } = require('../database/connection');
const QueryClassifier = require('./queryClassifier');

class SlowQueryCollector {
  constructor({ classifier, logger } = {}) {
    this.classifier = classifier || new QueryClassifier();
    this.logger = logger || console;
    this._running = false;
    this._interval = null;
    this.sampleIntervalMs = 60000; // 60s
  }

  /**
   * Sample pg_stat_statements and return raw query metrics.
   * Filters for queries with mean_time > 200ms.
   */
  async samplePgStatStatements() {
    try {
      const results = await sequelize.query(
        `SELECT
          query,
          calls,
          mean_time,
          total_time,
          stddev_time,
          min_time,
          max_time,
          queryid
        FROM pg_stat_statements
        WHERE mean_time > 200
        ORDER BY total_time DESC
        LIMIT 100`,
        { type: sequelize.QueryTypes.SELECT }
      );

      return results || [];
    } catch (error) {
      if (error.message && error.message.includes('pg_stat_statements')) {
        this.logger.warn(
          'pg_stat_statements extension is not enabled. ' +
          'Run: CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'
        );
      } else {
        this.logger.error('Failed to sample pg_stat_statements:', error.message);
      }
      return [];
    }
  }

  /**
   * Process raw pg_stat_statements rows into classified query metrics.
   */
  async collectOnce() {
    const rawRows = await this.samplePgStatStatements();
    if (rawRows.length === 0) return { collected: 0, classified: 0, persisted: 0 };

    const classified = [];

    for (const row of rawRows) {
      try {
        const normalized = this.classifier.classify({
          rawQuery: row.query,
          queryId: row.queryid,
          calls: row.calls,
          meanTimeMs: row.mean_time,
          totalTimeMs: row.total_time,
          stddevTimeMs: row.stddev_time,
          minTimeMs: row.min_time,
          maxTimeMs: row.max_time,
        });

        classified.push(normalized);
      } catch (err) {
        this.logger.error('Classification error for query:', err.message);
      }
    }

    // Persist classified queries to the database
    const persistResults = await this.classifier.persistClassified(classified);

    return {
      collected: rawRows.length,
      classified: classified.length,
      persisted: persistResults.length,
    };
  }

  /**
   * Start periodic collection.
   */
  start(intervalMs) {
    if (this._running) return;
    this._running = true;
    const interval = intervalMs || this.sampleIntervalMs;

    this._interval = setInterval(() => {
      this.collectOnce().catch((err) => {
        this.logger.error('Slow query collection error:', err);
      });
    }, interval);

    this.logger.info(`Slow query collector started with interval ${interval}ms`);
  }

  /**
   * Stop periodic collection.
   */
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._running = false;
  }
}

module.exports = SlowQueryCollector;
