'use strict';
const Groq = require('groq-sdk');

// Use the faster, more reliable model for JSON tasks
const MODEL = 'llama-3.3-70b-versatile';

function getGroq() {
  const key = process.env.GROQ_API_KEY || process.env.AI_INTEGRATIONS_GROQ_LLAMA_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not set. Add it to your .env file.');
  return new Groq({ apiKey: key });
}

// FIX 1: Strip markdown fences AND extract JSON robustly
function extractJSON(text) {
  // Strip markdown code fences like ```json ... ``` or ``` ... ```
  const stripped = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  // Try to extract first { } block
  const objMatch = stripped.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch (e) { /* fall through */ }
  }
  // Try to extract first [ ] block
  const arrMatch = stripped.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch (e) { /* fall through */ }
  }
  throw new Error('AI did not return valid JSON. Raw: ' + text.substring(0, 300));
}

// FIX 2: Timeout wrapper — never hang forever
function withTimeout(promise, ms = 40000, label = 'AI call') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

// FIX 3: Retry wrapper — one retry on failure
async function withRetry(fn, retries = 1, label = 'AI call') {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0) {
      console.warn(`[AI] ${label} failed, retrying... (${err.message})`);
      await new Promise(r => setTimeout(r, 1500));
      return withRetry(fn, retries - 1, label);
    }
    throw err;
  }
}

async function analyzePatent(patent, existingPatents = []) {
  const groq = getGroq();

  // FIX 4: Limit existing patents context — only send top 10, truncated descriptions
  // This is the main cause of hangs — too many patents = prompt too large for the model
  const topExisting = existingPatents.slice(0, 10);
  const existingContext = topExisting.length > 0
    ? topExisting
        .map((p, i) =>
          `[${i}] ID:${p.patent_id} | "${p.title}" | Domain:${p.technical_domain}\n    ${(p.description || '').substring(0, 200)}`
        )
        .join('\n')
    : 'No existing patents.';

  const prompt = `You are a senior patent examiner AI. Analyze this patent application and check it against existing patents for duplicates. Return ONLY a raw JSON object with no markdown, no explanation.

NEW PATENT:
Title: ${patent.title}
Domain: ${patent.technical_domain}
Inventor: ${patent.inventor_name}
Applicant: ${patent.applicant_name}
Description: ${(patent.description || '').substring(0, 800)}
Claims: ${(patent.claims || 'Not provided').substring(0, 400)}

EXISTING PATENTS (check for duplicates):
${existingContext}

RULES:
- isDuplicate = true ONLY if core invention concept has >65% overlap with an existing patent
- If isDuplicate = true, decisionRecommendation MUST be "REJECT"
- If no similar patent exists, noveltyScore should be 70-95 and decisionRecommendation should be "APPROVE"
- similarPatents: only include entries with similarityScore > 30

Return ONLY this JSON (no markdown, no backticks):
{
  "noveltyScore": <0-100>,
  "strengthScore": <0-100>,
  "abstract": "<2-3 sentence abstract>",
  "keywords": ["kw1", "kw2", "kw3"],
  "weaknesses": ["weakness1"],
  "improvements": ["improvement1"],
  "recommendation": "<1-2 sentence recommendation>",
  "isDuplicate": false,
  "duplicateOf": null,
  "duplicateReason": null,
  "similarPatents": [
    { "index": <array index>, "patent_id": "<id>", "title": "<title>", "similarityScore": <0-100>, "matchReason": "<reason>" }
  ],
  "decisionRecommendation": "APPROVE",
  "decisionReason": "<reason>"
}`;

  const call = () => withTimeout(
    groq.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1500,
    }),
    40000,
    'analyzePatent'
  );

  const completion = await withRetry(call, 1, 'analyzePatent');
  const raw = completion.choices[0]?.message?.content || '{}';
  const result = extractJSON(raw);

  return {
    noveltyScore:           typeof result.noveltyScore === 'number' ? result.noveltyScore : 65,
    strengthScore:          typeof result.strengthScore === 'number' ? result.strengthScore : 65,
    abstract:               result.abstract || '',
    keywords:               Array.isArray(result.keywords) ? result.keywords : [],
    weaknesses:             Array.isArray(result.weaknesses) ? result.weaknesses : [],
    improvements:           Array.isArray(result.improvements) ? result.improvements : [],
    recommendation:         result.recommendation || '',
    isDuplicate:            result.isDuplicate === true,
    duplicateOf:            result.duplicateOf || null,
    duplicateReason:        result.duplicateReason || null,
    // FIX 5: Accept both "matchReason" and "reason" from the model
    similarPatents:         Array.isArray(result.similarPatents)
      ? result.similarPatents.map(s => ({
          ...s,
          matchReason: s.matchReason || s.reason || '',
        }))
      : [],
    decisionRecommendation: result.decisionRecommendation === 'REJECT' ? 'REJECT' : 'APPROVE',
    decisionReason:         result.decisionReason || '',
  };
}

async function formalityCheck(patent) {
  const groq = getGroq();

  const prompt = `You are a patent formality examiner. Evaluate this patent for formal compliance. Return ONLY a raw JSON object — no markdown, no backticks.

PATENT:
Title: ${patent.title}
Domain: ${patent.technical_domain}
Inventor: ${patent.inventor_name}
Applicant: ${patent.applicant_name}
Description: ${(patent.description || '').substring(0, 1000)}
Claims: ${(patent.claims || 'Not provided').substring(0, 500)}

Formality requirements:
1. Title must be clear and at least 5 words
2. Description must be at least 150 words
3. Claims must be present and numbered
4. At least one independent claim required
5. Inventor and applicant names must be present
6. Technical domain must be specified

Return ONLY this JSON (no markdown, no backticks):
{
  "score": <0-100>,
  "passed": <true if score >= 70 and no critical issues>,
  "issues": ["<issue>"],
  "suggestions": ["<suggestion>"],
  "claimCount": <number>,
  "wordCount": <number>,
  "summary": "<1 sentence summary>"
}`;

  const call = () => withTimeout(
    groq.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 600,
    }),
    30000,
    'formalityCheck'
  );

  const completion = await withRetry(call, 1, 'formalityCheck');
  const raw = completion.choices[0]?.message?.content || '{}';
  const result = extractJSON(raw);

  return {
    score:       typeof result.score === 'number' ? Math.max(0, Math.min(100, result.score)) : 60,
    passed:      result.passed === true,
    issues:      Array.isArray(result.issues) ? result.issues : [],
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    claimCount:  result.claimCount || 0,
    wordCount:   result.wordCount || 0,
    summary:     result.summary || '',
  };
}

async function examinerCheck(patent) {
  const groq = getGroq();

  const aiReport = patent.ai_report
    ? (typeof patent.ai_report === 'string' ? patent.ai_report : JSON.stringify(patent.ai_report)).substring(0, 500)
    : 'No previous AI analysis';

  const prompt = `You are a senior patent examiner doing final review. Make a final APPROVE or REJECT decision. Return ONLY a raw JSON object — no markdown, no backticks.

PATENT:
Title: ${patent.title}
ID: ${patent.patent_id}
Domain: ${patent.technical_domain}
Novelty Score: ${patent.novelty_score || 'N/A'}
Strength Score: ${patent.patent_strength_score || 'N/A'}
Formality Score: ${patent.formality_score || 'N/A'}
Description: ${(patent.description || '').substring(0, 600)}
Claims: ${(patent.claims || 'Not provided').substring(0, 300)}
Prior AI Report: ${aiReport}

Decision: APPROVE if novelty >= 60, strength >= 60, formality >= 70 and claims are clear.
REJECT otherwise.

Return ONLY this JSON (no markdown, no backticks):
{
  "approved": <true or false>,
  "confidence": <0-100>,
  "reason": "<1-2 sentence reason>",
  "summary": "<brief summary>"
}`;

  const call = () => withTimeout(
    groq.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 400,
    }),
    30000,
    'examinerCheck'
  );

  const completion = await withRetry(call, 1, 'examinerCheck');
  const raw = completion.choices[0]?.message?.content || '{}';
  const result = extractJSON(raw);

  return {
    approved:   result.approved === true,
    confidence: typeof result.confidence === 'number' ? Math.max(0, Math.min(100, result.confidence)) : 75,
    reason:     result.reason || '',
    summary:    result.summary || '',
  };
}

async function checkPatentSimilarity(patent, existingPatents) {
  if (!existingPatents || existingPatents.length === 0) return [];

  const groq = getGroq();

  // FIX 6: Limit to 15 patents max for similarity check
  const limited = existingPatents.slice(0, 15);

  const prompt = `You are a patent similarity analyst. Compare the new patent against each existing patent. Return ONLY a raw JSON array — no markdown, no backticks.

NEW PATENT:
Title: ${patent.title}
Domain: ${patent.technical_domain}
Description: ${(patent.description || '').substring(0, 500)}
Claims: ${(patent.claims || '').substring(0, 250)}

EXISTING PATENTS:
${limited.map((p, i) => `[${i}] ${p.patent_id}: "${p.title}" — ${(p.description || '').substring(0, 200)}`).join('\n')}

Return ONLY a JSON array for patents with >15% similarity (empty array [] if none match):
[
  { "index": <0-based index>, "similarityScore": <0-100>, "matchReason": "<reason>" }
]`;

  const call = () => withTimeout(
    groq.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 500,
    }),
    30000,
    'checkPatentSimilarity'
  );

  const completion = await withRetry(call, 1, 'checkPatentSimilarity');
  const raw = completion.choices[0]?.message?.content || '[]';

  // Strip markdown and extract array
  const stripped = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const arrMatch = stripped.match(/\[[\s\S]*\]/);
  if (!arrMatch) return [];
  try {
    return JSON.parse(arrMatch[0]);
  } catch {
    return [];
  }
}

async function checkTrademarkSimilarity(name, brandText, trademarks) {
  if (!trademarks || trademarks.length === 0) {
    return {
      conflictRisk: 'LOW',
      similarIndices: [],
      recommendation: `"${name}" appears distinctive with no existing marks to conflict with.`,
    };
  }

  const groq = getGroq();

  // Limit to 20 trademarks
  const limited = trademarks.slice(0, 20);

  const prompt = `You are a trademark examiner. Evaluate if the proposed trademark conflicts with existing marks. Return ONLY a raw JSON object — no markdown, no backticks.

PROPOSED TRADEMARK: "${name}"
Brand Description: "${brandText || 'Not provided'}"

EXISTING TRADEMARKS:
${limited.map((t, i) => `[${i}] "${t.trademark_name}" — Class: ${t.goods_services_class || 'N/A'}`).join('\n')}

Consider phonetic, visual, conceptual similarity and class overlap.

Return ONLY this JSON (no markdown, no backticks):
{
  "conflictRisk": "<LOW|MEDIUM|HIGH>",
  "similarIndices": [<indices>],
  "recommendation": "<1-2 sentence recommendation>"
}`;

  const call = () => withTimeout(
    groq.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 300,
    }),
    25000,
    'checkTrademarkSimilarity'
  );

  const completion = await withRetry(call, 1, 'checkTrademarkSimilarity');
  const raw = completion.choices[0]?.message?.content || '{}';
  const result = extractJSON(raw);

  return {
    conflictRisk:   ['LOW', 'MEDIUM', 'HIGH'].includes(result.conflictRisk) ? result.conflictRisk : 'LOW',
    similarIndices: Array.isArray(result.similarIndices) ? result.similarIndices : [],
    recommendation: result.recommendation || '',
  };
}

module.exports = { analyzePatent, formalityCheck, examinerCheck, checkPatentSimilarity, checkTrademarkSimilarity };