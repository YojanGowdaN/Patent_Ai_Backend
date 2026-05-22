'use strict';
const express = require('express');
const router = express.Router();
const db = require('../lib/db');

// GET /api/dashboard/stats
router.get('/stats', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const todayIso = today.toISOString();
    const weekAgoIso = weekAgo.toISOString();

    const result = await db.query(`
      SELECT
        COUNT(*) AS total_patents,
        SUM(CASE WHEN status = 'Approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN status = 'Rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN status IN ('Formality Check Pending','Examiner Review','Approved','Rejected') THEN 1 ELSE 0 END) AS ai_reviewed,
        SUM(CASE WHEN status IN ('Submitted','Under AI Review','Formality Check Pending','Requires Modification','Examiner Review') THEN 1 ELSE 0 END) AS pending_review,
        SUM(CASE WHEN similarity_risk = TRUE THEN 1 ELSE 0 END) AS duplicate_risk,
        SUM(CASE WHEN created_at >= $1 THEN 1 ELSE 0 END) AS today_submissions,
        SUM(CASE WHEN created_at >= $2 THEN 1 ELSE 0 END) AS weekly_submissions,
        ROUND(AVG(novelty_score), 1) AS avg_novelty_score,
        ROUND(AVG(patent_strength_score), 1) AS avg_strength_score
      FROM patents
    `, [todayIso, weekAgoIso]);

    const row = result.rows[0] || {};
    res.json({
      total_patents: parseInt(row.total_patents) || 0,
      approved: parseInt(row.approved) || 0,
      rejected: parseInt(row.rejected) || 0,
      ai_reviewed: parseInt(row.ai_reviewed) || 0,
      pending_review: parseInt(row.pending_review) || 0,
      duplicate_risk: parseInt(row.duplicate_risk) || 0,
      today_submissions: parseInt(row.today_submissions) || 0,
      weekly_submissions: parseInt(row.weekly_submissions) || 0,
      avg_novelty_score: row.avg_novelty_score != null ? parseFloat(row.avg_novelty_score) : null,
      avg_strength_score: row.avg_strength_score != null ? parseFloat(row.avg_strength_score) : null,
    });
  } catch (err) {
    console.error('[Dashboard] stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/dashboard/recent-activity
router.get('/recent-activity', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM activity ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (err) {
    console.error('[Dashboard] activity error:', err);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// GET /api/dashboard/domain-breakdown
router.get('/domain-breakdown', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT technical_domain AS domain, COUNT(*) AS count FROM patents GROUP BY technical_domain ORDER BY count DESC'
    );
    res.json(result.rows.map(r => ({ domain: r.domain, count: parseInt(r.count) })));
  } catch (err) {
    console.error('[Dashboard] domain error:', err);
    res.status(500).json({ error: 'Failed to fetch domain breakdown' });
  }
});

// GET /api/dashboard/status-breakdown
router.get('/status-breakdown', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT status, COUNT(*) AS count FROM patents GROUP BY status ORDER BY count DESC'
    );
    res.json(result.rows.map(r => ({ status: r.status, count: parseInt(r.count) })));
  } catch (err) {
    console.error('[Dashboard] status error:', err);
    res.status(500).json({ error: 'Failed to fetch status breakdown' });
  }
});

module.exports = router;
