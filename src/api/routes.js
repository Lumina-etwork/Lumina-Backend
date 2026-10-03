import express from 'express';
import { statements } from '../db/schema.js';
import { sanitizeProfile, rankCandidates } from '../ai/bias_sanitizer.js';

export function createRouter({ db, contractId, startedAt = Date.now() }) {
  const router = express.Router();
  const stmt = statements(db);

  router.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      contract_id: contractId,
      uptime_ms: Date.now() - startedAt,
      timestamp: Math.floor(Date.now() / 1000),
    });
  });

  router.get('/api/assets', (_req, res) => {
    const rows = stmt.listAssets.all();
    res.json(
      rows.map((row) => ({
        onchain_id: row.onchain_id,
        creator: row.creator,
        fingerprint: row.fingerprint,
        metadata_uri: row.metadata_uri,
        licensing_fee: row.licensing_fee,
        timestamp: row.timestamp,
      })),
    );
  });

  /**
   * Blind recruitment pool. Only pseudonymized, merit-derived fields are
   * emitted -- `sanitizeProfile` is the single egress point, so a demographic
   * column added to the DB later still cannot leak.
   */
  router.get('/api/creators/blind-pool', (_req, res) => {
    const pool = stmt.listCreators.all().map(sanitizeProfile);
    res.json(pool);
  });

  router.post('/api/match', (req, res) => {
    const body = req.body ?? {};
    const pool = stmt.listCreators.all();
    const ranked = rankCandidates(
      {
        required_skills: body.required_skills,
        min_merit_score: body.min_merit_score,
        min_completion_rate: body.min_completion_rate,
      },
      pool,
    );

    res.json(
      ranked.map(({ matched_skills, match_score, ...blind }) => ({
        ...blind,
        matched_skills,
        match_score,
      })),
    );
  });

  router.get('/api/escrows', (_req, res) => {
    const rows = db.prepare('SELECT * FROM escrows ORDER BY id').all();
    res.json(
      rows.map((r) => ({
        onchain_id: r.onchain_id,
        client: r.client,
        creator: r.creator,
        total_amount: r.total_amount,
        remaining_balance: r.remaining_balance,
        completed_milestones: r.completed_milestones,
        total_milestones: r.total_milestones,
        status: r.status,
      })),
    );
  });

  return router;
}
