/**
 * Dead Letter Queue Management Routes
 *
 * Issue #104: Dead Letter Queue for Failed Asynchronous Message Processing
 *
 * Endpoints:
 *   GET  /api/dlq               - List DLQ entries (optional ?error_type, pagination)
 *   GET  /api/dlq/:id           - Retrieve a single DLQ entry by UUID
 *   POST /api/dlq/:id/retry     - Re-enqueue a DLQ entry via deadLetterQueueService
 *   POST /api/dlq/purge         - Delete entries older than 7 days from PostgreSQL
 *
 * The PostgreSQL table (dead_letter_queue) provides an audit trail.
 * The BullMQ/Redis layer (deadLetterQueueService) is the live queue.
 */

const express = require('express');
const router = express.Router();
const { sequelize } = require('../database/connection');
const queueService = require('../services/queueService');

const DLQ_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// Helper: execute a raw SQL query against the dead_letter_queue table.
// In test mode sequelize uses SQLite, so we guard against missing tables
// gracefully.
// ---------------------------------------------------------------------------
async function queryDlq(sql, replacements = {}) {
  const result = await sequelize.query(sql, {
    replacements,
    type: sequelize.constructor.QueryTypes ? sequelize.constructor.QueryTypes.SELECT : 'SELECT',
  });
  // Sequelize returns [rows, meta] for raw queries; normalize to rows array.
  return Array.isArray(result[0]) ? result[0] : result;
}

async function executeDlq(sql, replacements = {}) {
  return sequelize.query(sql, { replacements });
}

// ---------------------------------------------------------------------------
// GET /api/dlq
// List DLQ entries. Supports ?error_type, ?limit (default 50), ?offset (0).
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const {
      error_type,
      limit = 50,
      offset = 0,
    } = req.query;

    const parsedLimit  = Math.min(Math.max(1, Number(limit)  || 50),  200);
    const parsedOffset = Math.max(0, Number(offset) || 0);

    let whereClause = '';
    const replacements = { limit: parsedLimit, offset: parsedOffset };

    if (error_type) {
      whereClause = 'WHERE error_type = :error_type';
      replacements.error_type = error_type;
    }

    const rows = await queryDlq(
      `SELECT id, source_queue, source_job_id, error_type, retry_count, failed_at, created_at
         FROM dead_letter_queue
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT :limit OFFSET :offset`,
      replacements,
    );

    // Count query
    const countRows = await queryDlq(
      `SELECT COUNT(*) AS total FROM dead_letter_queue ${whereClause}`,
      error_type ? { error_type } : {},
    );
    const total = Number(countRows[0]?.total ?? countRows[0]?.count ?? 0);

    res.json({
      success: true,
      data: {
        entries: rows,
        total,
        limit: parsedLimit,
        offset: parsedOffset,
      },
    });
  } catch (error) {
    console.error('Error listing DLQ entries:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dlq/:id
// Retrieve full detail of a single DLQ entry.
// NOTE: this route must come BEFORE /purge to avoid Express treating "purge"
// as an :id — we register /purge as POST so there is no conflict.
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const rows = await queryDlq(
      `SELECT * FROM dead_letter_queue WHERE id = :id LIMIT 1`,
      { id },
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, error: 'DLQ entry not found' });
    }

    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Error fetching DLQ entry:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/dlq/purge
// Delete all entries from PostgreSQL older than 7 days.
// ---------------------------------------------------------------------------
router.post('/purge', async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - DLQ_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const [, meta] = await executeDlq(
      `DELETE FROM dead_letter_queue WHERE created_at < :cutoff`,
      { cutoff },
    );

    // rowCount is available in Postgres; affectedRows in SQLite
    const deleted = meta?.rowCount ?? meta?.changes ?? 0;

    res.json({
      success: true,
      data: { deleted, cutoff },
    });
  } catch (error) {
    console.error('Error purging DLQ entries:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/dlq/:id/retry
// Re-enqueue a DLQ message via the deadLetterQueueService (BullMQ/Redis).
// ---------------------------------------------------------------------------
router.post('/:id/retry', async (req, res) => {
  try {
    const { id } = req.params;

    const retriedJob = await queueService.retryDeadLetterJob(id);

    if (!retriedJob) {
      return res.status(404).json({
        success: false,
        error: 'DLQ job not found in queue — it may have already been retried or expired',
      });
    }

    res.json({
      success: true,
      data: {
        retriedJobId: retriedJob.id,
        dlqJobId: id,
      },
    });
  } catch (error) {
    console.error('Error retrying DLQ job:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
