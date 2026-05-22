'use strict';
const Groq = require('groq-sdk');

const MODEL = 'llama-3.1-8b-instant';

function getGroq() {
  const key = process.env.GROQ_API_KEY || process.env.AI_INTEGRATIONS_GROQ_LLAMA_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not set. Add it to your .env file.');
  return new Groq({ apiKey: key });
}

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return valid JSON. Raw: ' + text.substring(0, 200));
  return JSON.parse(match[0]);
}

async function analyzePatent(patent, existingPatents = []) {
  const groq = getGroq();

  const existingContext = existingPatents.length > 0
    ? existingPatents
        .map((p, i) =>
          `[${i + 1}] PatentID: ${p.patent_id} | Title: ${p.title} | Domain: ${p.technical_domain}\n    Description: ${(p.description || '').substring(0, 400)}\n    Claims: ${(p.claims || '').substring(0, 200)}`
        )
        .join('\n\n')
    : 'No existing patents in database yet.';

  const prompt = `You are a senior patent examiner AI working for a national intellectual property office.

TASK: Analyze the patent application below. Then check it against all existing patents in the database to detect any duplicates or prior art conflicts. Return a single JSON object — no markdown, no explanation, just raw JSON.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NEW PATENT APPLICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Title:            ${patent.title}
Technical Domain: ${patent.technical_domain}
Inventor:         ${patent.inventor_name}
Applicant:        ${patent.applicant_name}
Description:
${patent.description}

Claims:
${patent.claims || 'Not provided'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXISTING PATENTS IN DATABASE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${existingContext}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANALYSIS RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. isDuplicate = true if the core invention concept has >65% conceptual overlap with ANY existing patent.
2. If isDuplicate = true → decisionRecommendation MUST be "REJECT".
3. noveltyScore must reflect actual novelty vs existing patents. If a near-duplicate exists, score must be below 35.
4. Be strict. Patent offices reject tens of thousands of applications for prior art conflicts.
5. similarPatents: list every existing patent that overlaps significantly (score > 30).

Return ONLY this JSON structure:
{
  "noveltyScore": <integer 0-100>,
  "strengthScore": <integer 0-100>,
  "abstract": "<2-3 sentence professional technical abstract>",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4"],
  "weaknesses": ["<specific weakness>", "..."],
  "improvements": ["<specific improvement suggestion>", "..."],
  "recommendation": "<professional 1-2 sentence recommendation>",
  "isDuplicate": <true|false>,
  "duplicateOf": "<patent_id string if duplicate, otherwise null>",
  "duplicateReason": "<concise reason why it is a duplicate, or null>",
  "similarPatents": [
    { "patent_id": "<id>", "title": "<title>", "similarityScore": <0-100>, "reason": "<reason>" }
  ],
  "decisionRecommendation": "<APPROVE|REJECT>",
  "decisionReason": "<1-2 sentence reason for the decision>"
}`;

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 2000,
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  const result = extractJSON(raw);

  return {
    noveltyScore:          typeof result.noveltyScore === 'number' ? result.noveltyScore : 50,
    strengthScore:         typeof result.strengthScore === 'number' ? result.strengthScore : 50,
    abstract:              result.abstract || '',
    keywords:              Array.isArray(result.keywords) ? result.keywords : [],
    weaknesses:            Array.isArray(result.weaknesses) ? result.weaknesses : [],
    improvements:          Array.isArray(result.improvements) ? result.improvements : [],
    recommendation:        result.recommendation || '',
    isDuplicate:           result.isDuplicate === true,
    duplicateOf:           result.duplicateOf || null,
    duplicateReason:       result.duplicateReason || null,
    similarPatents:        Array.isArray(result.similarPatents) ? result.similarPatents : [],
    decisionRecommendation: result.decisionRecommendation === 'REJECT' ? 'REJECT' : 'APPROVE',
    decisionReason:        result.decisionReason || '',
  };
}

async function formalityCheck(patent) {
  const groq = getGroq();

  const prompt = `You are a patent formality examiner. Evaluate the following patent application for formal compliance requirements. Return ONLY raw JSON — no markdown.

PATENT APPLICATION:
Title:            ${patent.title}
Technical Domain: ${patent.technical_domain}
Inventor:         ${patent.inventor_name}
Applicant:        ${patent.applicant_name}
Description:
${patent.description}

Claims:
${patent.claims || 'Not provided'}

Check against these formality requirements:
1. Title must be clear, specific, and at least 5 words
2. Description must be at least 150 words and technically detailed
3. Claims must be present and properly numbered (1. 2. 3. format)
4. Must include at least one independent claim
5. Inventor and applicant names must be provided
6. Technical domain must be specified
7. Description should include background/field of invention
8. Claims should be clear and not overly broad

Return ONLY this JSON:
{
  "score": <integer 0-100>,
  "passed": <true if score >= 70 and no critical issues, false otherwise>,
  "issues": ["<issue description>", "..."],
  "suggestions": ["<improvement suggestion>", "..."],
  "claimCount": <number of claims found>,
  "wordCount": <approximate word count of description>,
  "summary": "<1 sentence summary of formality status>"
}`;

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 800,
  });

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

async function checkPatentSimilarity(patent, existingPatents) {
  if (!existingPatents || existingPatents.length === 0) return [];

  const groq = getGroq();

  const prompt = `You are a patent similarity analyst. Compare the new patent against each existing patent and return similarity scores. Return ONLY raw JSON — no markdown.

NEW PATENT:
Title: ${patent.title}
Domain: ${patent.technical_domain}
Description: ${(patent.description || '').substring(0, 600)}
Claims: ${(patent.claims || '').substring(0, 300)}

EXISTING PATENTS:
${existingPatents.map((p, i) => `[${i}] ${p.patent_id}: "${p.title}" — ${(p.description || '').substring(0, 300)}`).join('\n')}

Return ONLY this JSON (array, one entry per existing patent that has >15% similarity):
[
  { "index": <array index>, "similarityScore": <0-100>, "matchReason": "<concise reason>" }
]`;

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 600,
  });

  const raw = completion.choices[0]?.message?.content || '[]';
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  if (!arrMatch) return [];
  return JSON.parse(arrMatch[0]);
}

async function checkTrademarkSimilarity(name, brandText, trademarks) {
  if (!trademarks || trademarks.length === 0) {
    return { conflictRisk: 'LOW', similarIndices: [], recommendation: `"${name}" appears distinctive with no existing marks to conflict with.` };
  }

  const groq = getGroq();

  const prompt = `You are a trademark examiner. Evaluate whether the proposed trademark conflicts with any existing registered marks. Return ONLY raw JSON — no markdown.

PROPOSED TRADEMARK: "${name}"
Brand Description: "${brandText || 'Not provided'}"

EXISTING REGISTERED TRADEMARKS:
${trademarks.map((t, i) => `[${i}] "${t.trademark_name}" — Class: ${t.goods_services_class || 'N/A'}`).join('\n')}

Consider: phonetic similarity, visual similarity, conceptual similarity, and goods/services class overlap.

Return ONLY this JSON:
{
  "conflictRisk": "<LOW|MEDIUM|HIGH>",
  "similarIndices": [<indices of conflicting marks>],
  "recommendation": "<1-2 sentence professional recommendation>"
}`;

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 400,
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  const result = extractJSON(raw);

  return {
    conflictRisk:   ['LOW', 'MEDIUM', 'HIGH'].includes(result.conflictRisk) ? result.conflictRisk : 'LOW',
    similarIndices: Array.isArray(result.similarIndices) ? result.similarIndices : [],
    recommendation: result.recommendation || '',
  };
}

module.exports = { analyzePatent, formalityCheck, checkPatentSimilarity, checkTrademarkSimilarity };
