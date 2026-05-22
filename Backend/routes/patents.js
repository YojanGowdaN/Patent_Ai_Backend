'use strict';
const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const ai = require('../lib/ai');

function generatePatentId() {
  const year = new Date().getFullYear();
  const num = Math.floor(Math.random() * 9000) + 1000;
  return `PAT-${year}-${num}`;
}

async function logActivity(patentId, patentTitle, action) {
  try {
    await db.query(
      'INSERT INTO activity (patent_id, patent_title, action) VALUES ($1, $2, $3)',
      [patentId, patentTitle, action]
    );
  } catch (err) {
    console.error('[Activity] log error:', err.message);
  }
}

// GET /api/patents
router.get('/', async (req, res) => {
  try {
    const { status, domain, search, applicant, year } = req.query;
    let queryText = 'SELECT * FROM patents WHERE 1=1';
    const params = [];
    let idx = 1;

    if (status)    { queryText += ` AND status = $${idx++}`;                          params.push(status); }
    if (domain)    { queryText += ` AND technical_domain = $${idx++}`;                params.push(domain); }
    if (applicant) { queryText += ` AND applicant_name ILIKE $${idx++}`;              params.push(`%${applicant}%`); }
    if (year)      { queryText += ` AND EXTRACT(YEAR FROM filing_date) = $${idx++}`;  params.push(parseInt(year)); }
    if (search) {
      queryText += ` AND (title ILIKE $${idx} OR description ILIKE $${idx} OR patent_id ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    queryText += ' ORDER BY created_at DESC';
    const result = await db.query(queryText, params);
    res.json(result.rows);
  } catch (err) {
    console.error('[Patents] list error:', err);
    res.status(500).json({ error: 'Failed to fetch patents' });
  }
});

// POST /api/patents
router.post('/', async (req, res) => {
  try {
    const { applicant_name, inventor_name, title, description, technical_domain, claims } = req.body;
    if (!applicant_name || !title || !description || !technical_domain) {
      return res.status(400).json({ error: 'Missing required fields: applicant_name, title, description, technical_domain' });
    }
    const patentId = generatePatentId();
    const result = await db.query(
      `INSERT INTO patents (patent_id, applicant_name, inventor_name, title, description, technical_domain, claims, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Submitted') RETURNING *`,
      [patentId, applicant_name, inventor_name || applicant_name, title, description, technical_domain, claims || null]
    );
    await logActivity(patentId, title, 'Patent submitted');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Patents] create error:', err);
    res.status(500).json({ error: 'Failed to submit patent' });
  }
});

// GET /api/patents/:id
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
    const result = await db.query('SELECT * FROM patents WHERE id = $1', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Patent not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Patents] get error:', err);
    res.status(500).json({ error: 'Failed to fetch patent' });
  }
});

// PATCH /api/patents/:id
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
    const { status, novelty_score, patent_strength_score, formality_score, ai_report, similarity_risk } = req.body;
    const result = await db.query(
      `UPDATE patents SET
        status                = COALESCE($2, status),
        novelty_score         = COALESCE($3, novelty_score),
        patent_strength_score = COALESCE($4, patent_strength_score),
        formality_score       = COALESCE($5, formality_score),
        ai_report             = COALESCE($6, ai_report),
        similarity_risk       = COALESCE($7, similarity_risk),
        updated_at            = NOW()
       WHERE id = $1 RETURNING *`,
      [id, status, novelty_score, patent_strength_score, formality_score, ai_report, similarity_risk]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Patent not found' });
    if (status) await logActivity(result.rows[0].patent_id, result.rows[0].title, `Status changed to: ${status}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Patents] update error:', err);
    res.status(500).json({ error: 'Failed to update patent' });
  }
});

// POST /api/patents/:id/analyze
// Runs full Groq AI analysis — checks novelty, strength, AND compares against every
// existing patent in the database. If a duplicate is detected the patent is auto-rejected.
router.post('/:id/analyze', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const { rows } = await db.query('SELECT * FROM patents WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Patent not found' });
    const patent = rows[0];

    // Fetch all other approved/reviewed patents for duplicate checking
    const existingResult = await db.query(
      `SELECT id, patent_id, title, technical_domain, description, claims
       FROM patents
       WHERE id != $1
         AND status NOT IN ('Rejected', 'Requires Modification')
       ORDER BY created_at DESC`,
      [id]
    );
    const existingPatents = existingResult.rows;

    // Mark as under review
    await db.query("UPDATE patents SET status = 'Under AI Review', updated_at = NOW() WHERE id = $1", [id]);
    await logActivity(patent.patent_id, patent.title, 'AI analysis started');

    // Run Groq analysis (includes duplicate detection against existing patents)
    const analysis = await ai.analyzePatent(patent, existingPatents);

    // Decide final status based on AI recommendation
    const isDuplicate   = analysis.isDuplicate === true;
    const shouldReject  = analysis.decisionRecommendation === 'REJECT' || isDuplicate;
    const newStatus     = shouldReject ? 'Rejected' : 'Formality Check Pending';
    const similarityRisk = isDuplicate || (analysis.similarPatents && analysis.similarPatents.some(s => s.similarityScore >= 65));

    await db.query(
      `UPDATE patents SET
        novelty_score         = $2,
        patent_strength_score = $3,
        ai_report             = $4,
        similarity_risk       = $5,
        status                = $6,
        updated_at            = NOW()
       WHERE id = $1`,
      [
        id,
        analysis.noveltyScore,
        analysis.strengthScore,
        JSON.stringify(analysis),
        similarityRisk,
        newStatus,
      ]
    );

    const logMsg = isDuplicate
      ? `AI analysis: REJECTED as duplicate of ${analysis.duplicateOf} — ${analysis.duplicateReason}`
      : `AI analysis completed — novelty: ${analysis.noveltyScore}, strength: ${analysis.strengthScore}, decision: ${analysis.decisionRecommendation}`;

    await logActivity(patent.patent_id, patent.title, logMsg);

    res.json({
      patent_id:     id,
      status:        newStatus,
      isDuplicate,
      duplicateOf:   analysis.duplicateOf,
      duplicateReason: analysis.duplicateReason,
      similarPatents: analysis.similarPatents,
      decisionRecommendation: analysis.decisionRecommendation,
      decisionReason: analysis.decisionReason,
      noveltyScore:  analysis.noveltyScore,
      strengthScore: analysis.strengthScore,
      abstract:      analysis.abstract,
      keywords:      analysis.keywords,
      weaknesses:    analysis.weaknesses,
      improvements:  analysis.improvements,
      recommendation: analysis.recommendation,
    });
  } catch (err) {
    console.error('[Patents] analyze error:', err);
    const msg = err.message.includes('GROQ_API_KEY')
      ? 'GROQ_API_KEY not configured. Add it to your .env file.'
      : 'AI analysis failed: ' + err.message;
    res.status(500).json({ error: msg });
  }
});

// POST /api/patents/:id/formality-check
// Runs Groq AI formality check — evaluates title, description, claims quality.
router.post('/:id/formality-check', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const { rows } = await db.query('SELECT * FROM patents WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Patent not found' });
    const patent = rows[0];

    const result = await ai.formalityCheck(patent);

    const newStatus = result.passed ? 'Examiner Review' : 'Requires Modification';

    await db.query(
      'UPDATE patents SET formality_score = $2, status = $3, updated_at = NOW() WHERE id = $1',
      [id, result.score, newStatus]
    );

    await logActivity(
      patent.patent_id,
      patent.title,
      `Formality check ${result.passed ? 'PASSED' : 'FAILED'} (score: ${result.score}) — ${result.summary}`
    );

    res.json({
      patent_id:      id,
      formality_score: result.score,
      passed:         result.passed,
      status:         newStatus,
      issues:         result.issues,
      suggestions:    result.suggestions,
      claimCount:     result.claimCount,
      wordCount:      result.wordCount,
      summary:        result.summary,
    });
  } catch (err) {
    console.error('[Patents] formality error:', err);
    const msg = err.message.includes('GROQ_API_KEY')
      ? 'GROQ_API_KEY not configured. Add it to your .env file.'
      : 'Formality check failed: ' + err.message;
    res.status(500).json({ error: msg });
  }
});

// POST /api/patents/:id/similarity
// Runs Groq AI similarity comparison against same-domain patents.
router.post('/:id/similarity', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const { rows } = await db.query('SELECT * FROM patents WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Patent not found' });
    const patent = rows[0];

    const others = await db.query(
      'SELECT * FROM patents WHERE technical_domain = $1 AND id != $2 ORDER BY created_at DESC LIMIT 20',
      [patent.technical_domain, id]
    );

    if (!others.rows.length) {
      await db.query('UPDATE patents SET similarity_risk = false, updated_at = NOW() WHERE id = $1', [id]);
      return res.json([]);
    }

    const similarities = await ai.checkPatentSimilarity(patent, others.rows);
    const highRisk = similarities.some(s => s.similarityScore >= 65);

    await db.query('UPDATE patents SET similarity_risk = $2, updated_at = NOW() WHERE id = $1', [id, highRisk]);
    if (highRisk) await logActivity(patent.patent_id, patent.title, 'High similarity/duplicate risk detected by AI');

    const results = similarities
      .filter(s => typeof s.index === 'number' && s.index < others.rows.length)
      .map(s => ({
        patent_id:        others.rows[s.index].patent_id,
        title:            others.rows[s.index].title,
        applicant_name:   others.rows[s.index].applicant_name,
        similarity_score: s.similarityScore,
        match_reason:     s.matchReason,
      }));

    res.json(results);
  } catch (err) {
    console.error('[Patents] similarity error:', err);
    const msg = err.message.includes('GROQ_API_KEY')
      ? 'GROQ_API_KEY not configured. Add it to your .env file.'
      : 'Similarity check failed: ' + err.message;
    res.status(500).json({ error: msg });
  }
});

// POST /api/patents/:id/decision  — examiner final decision
router.post('/:id/decision', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
    const { decision, notes } = req.body;
    if (!['Approved', 'Rejected'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be "Approved" or "Rejected"' });
    }

    const { rows } = await db.query('SELECT * FROM patents WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Patent not found' });
    const patent = rows[0];

    await db.query(
      'UPDATE patents SET status = $2, updated_at = NOW() WHERE id = $1',
      [id, decision]
    );

    await logActivity(
      patent.patent_id,
      patent.title,
      `Examiner decision: ${decision}${notes ? ' — ' + notes : ''}`
    );

    res.json({ patent_id: id, status: decision, notes });
  } catch (err) {
    console.error('[Patents] decision error:', err);
    res.status(500).json({ error: 'Failed to record decision' });
  }
});

module.exports = router;
