'use strict';
const express = require('express');
const router  = express.Router();
const ai      = require('../lib/ai');

function aiError(res, err) {
  console.error('[AI]', err.message);
  const msg = err.message.includes('GROQ_API_KEY')
    ? 'GROQ_API_KEY not set — add it to your .env file.'
    : err.message;
  res.status(500).json({ error: msg });
}

// POST /api/ai/analyze
// Body: { patent, existingPatents }
router.post('/analyze', async (req, res) => {
  try {
    const { patent, existingPatents = [] } = req.body;
    if (!patent) return res.status(400).json({ error: 'Missing patent data' });
    const result = await ai.analyzePatent(patent, existingPatents);
    res.json(result);
  } catch (err) { aiError(res, err); }
});

// POST /api/ai/formality-check
// Body: { patent }
router.post('/formality-check', async (req, res) => {
  try {
    const { patent } = req.body;
    if (!patent) return res.status(400).json({ error: 'Missing patent data' });
    const result = await ai.formalityCheck(patent);
    res.json(result);
  } catch (err) { aiError(res, err); }
});

// POST /api/ai/examiner-check
// Body: { patent }
// Runs final AI examiner review to approve or reject
router.post('/examiner-check', async (req, res) => {
  try {
    const { patent } = req.body;
    if (!patent) return res.status(400).json({ error: 'Missing patent data' });
    const result = await ai.examinerCheck(patent);
    res.json(result);
  } catch (err) { aiError(res, err); }
});

// POST /api/ai/similarity
// Body: { patent, existingPatents }
router.post('/similarity', async (req, res) => {
  try {
    const { patent, existingPatents = [] } = req.body;
    if (!patent) return res.status(400).json({ error: 'Missing patent data' });
    if (!existingPatents.length) return res.json([]);

    const similarities = await ai.checkPatentSimilarity(patent, existingPatents);
    const results = similarities
      .filter(s => typeof s.index === 'number' && s.index < existingPatents.length)
      .map(s => ({
        patent_id:       existingPatents[s.index].patent_id,
        title:           existingPatents[s.index].title,
        applicant_name:  existingPatents[s.index].applicant_name,
        similarity_score: s.similarityScore,
        match_reason:    s.matchReason,
      }));
    res.json(results);
  } catch (err) { aiError(res, err); }
});

// POST /api/ai/trademark-check
// Body: { trademark_name, brand_text, existingTrademarks }
router.post('/trademark-check', async (req, res) => {
  try {
    const { trademark_name, brand_text, existingTrademarks = [] } = req.body;
    if (!trademark_name) return res.status(400).json({ error: 'Missing trademark_name' });

    const result = await ai.checkTrademarkSimilarity(trademark_name, brand_text, existingTrademarks);

    // Map indices → full trademark objects for the frontend
    const similar_trademarks = (result.similarIndices || [])
      .filter(i => i < existingTrademarks.length)
      .map(i => existingTrademarks[i]);

    res.json({
      conflict_risk:      result.conflictRisk,
      recommendation:     result.recommendation,
      similar_trademarks,
    });
  } catch (err) { aiError(res, err); }
});

module.exports = router;
