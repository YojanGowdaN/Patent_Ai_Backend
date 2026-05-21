'use strict';
const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const ai = require('../lib/ai');

// GET /api/trademarks
router.get('/', async (req, res) => {
  try {
    const { search, status } = req.query;
    let queryText = 'SELECT * FROM trademarks WHERE 1=1';
    const params = [];
    let idx = 1;
    if (search) {
      queryText += ` AND (trademark_name ILIKE $${idx} OR owner ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }
    if (status) { queryText += ` AND status = $${idx++}`; params.push(status); }
    queryText += ' ORDER BY created_at DESC';
    const result = await db.query(queryText, params);
    res.json(result.rows);
  } catch (err) {
    console.error('[Trademarks] list error:', err);
    res.status(500).json({ error: 'Failed to fetch trademarks' });
  }
});

// POST /api/trademarks
router.post('/', async (req, res) => {
  try {
    const { trademark_name, owner, category } = req.body;
    if (!trademark_name || !owner || !category) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const result = await db.query(
      "INSERT INTO trademarks (trademark_name, owner, category, status) VALUES ($1, $2, $3, 'Active') RETURNING *",
      [trademark_name, owner, category]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Trademarks] create error:', err);
    res.status(500).json({ error: 'Failed to register trademark' });
  }
});

// POST /api/trademarks/check
router.post('/check', async (req, res) => {
  try {
    const { trademark_name, brand_text } = req.body;
    if (!trademark_name || !brand_text) {
      return res.status(400).json({ error: 'Missing trademark_name or brand_text' });
    }
    const all = await db.query('SELECT * FROM trademarks');
    const result = await ai.checkTrademarkSimilarity(trademark_name, brand_text, all.rows);
    const similarTrademarks = (result.similarIndices || [])
      .filter(i => i < all.rows.length)
      .map(i => all.rows[i]);
    res.json({
      input_name: trademark_name,
      conflict_risk: result.conflictRisk || 'LOW',
      similar_trademarks: similarTrademarks,
      recommendation: result.recommendation || 'No significant conflicts detected.',
    });
  } catch (err) {
    console.error('[Trademarks] check error:', err);
    res.status(500).json({ error: 'Trademark check failed' });
  }
});

module.exports = router;
