import { Router, type IRouter } from "express";
import { eq, desc, avg, count, ilike, or, sql } from "drizzle-orm";
import { db, patentsTable, PatentStatus } from "@workspace/db";
import {
  AnalyzePatentBody,
  GetPatentParams,
  DeletePatentParams,
  GetPatentResponse,
  ListPatentsResponse,
  GetPatentStatsResponse,
  SearchPatentsQueryParams,
  SearchPatentsResponse,
  FormalityCheckBody,
  FormalityCheckResponse,
  SimilarityCheckBody,
  SimilarityCheckResponse,
  UpdatePatentStatusParams,
  UpdatePatentStatusBody,
  UpdatePatentStatusResponse,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

function generatePatentNumber(): string {
  const year = new Date().getFullYear();
  const rand = Math.floor(Math.random() * 9000000) + 1000000;
  return `PAT-${year}-${rand}`;
}

router.get("/patents", async (_req, res): Promise<void> => {
  const patents = await db
    .select()
    .from(patentsTable)
    .orderBy(desc(patentsTable.createdAt));
  res.json(ListPatentsResponse.parse(patents));
});

router.get("/patents/stats", async (_req, res): Promise<void> => {
  const [totals] = await db
    .select({
      totalAnalyses: count(patentsTable.id),
      averageNoveltyScore: avg(patentsTable.noveltyScore),
      averageStrengthScore: avg(patentsTable.patentStrengthScore),
    })
    .from(patentsTable);

  const pendingStatuses = [
    PatentStatus.SUBMITTED,
    PatentStatus.UNDER_AI_REVIEW,
    PatentStatus.FORMALITY_CHECK,
    PatentStatus.EXAMINER_REVIEW,
    PatentStatus.REQUIRES_MODIFICATION,
  ];

  const [pendingRow] = await db
    .select({ count: count(patentsTable.id) })
    .from(patentsTable)
    .where(
      sql`${patentsTable.status} = ANY(ARRAY[${sql.raw(pendingStatuses.map((s) => `'${s}'`).join(","))}]::text[])`,
    );

  const [approvedRow] = await db
    .select({ count: count(patentsTable.id) })
    .from(patentsTable)
    .where(eq(patentsTable.status, PatentStatus.APPROVED));

  const [rejectedRow] = await db
    .select({ count: count(patentsTable.id) })
    .from(patentsTable)
    .where(eq(patentsTable.status, PatentStatus.REJECTED));

  const domainRows = await db
    .select({
      domain: patentsTable.technicalDomain,
      count: count(patentsTable.id),
    })
    .from(patentsTable)
    .groupBy(patentsTable.technicalDomain)
    .orderBy(desc(count(patentsTable.id)))
    .limit(10);

  const statusRows = await db
    .select({
      status: patentsTable.status,
      count: count(patentsTable.id),
    })
    .from(patentsTable)
    .groupBy(patentsTable.status)
    .orderBy(desc(count(patentsTable.id)));

  const recentActivity = await db
    .select()
    .from(patentsTable)
    .orderBy(desc(patentsTable.createdAt))
    .limit(5);

  res.json(
    GetPatentStatsResponse.parse({
      totalAnalyses: totals?.totalAnalyses ?? 0,
      pendingCount: pendingRow?.count ?? 0,
      approvedCount: approvedRow?.count ?? 0,
      rejectedCount: rejectedRow?.count ?? 0,
      averageNoveltyScore: Number(totals?.averageNoveltyScore ?? 0),
      averageStrengthScore: Number(totals?.averageStrengthScore ?? 0),
      topDomains: domainRows.map((r: any) => ({ domain: r.domain, count: r.count })),
      recentActivity,
      statusBreakdown: statusRows.map((r: any) => ({
        status: r.status,
        count: r.count,
      })),
    }),
  );
});

router.get("/patents/search", async (req, res): Promise<void> => {
  const params = SearchPatentsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { q, domain, status } = params.data;

  let baseQuery = db.select().from(patentsTable).$dynamic();
  const conditions = [];

  if (q) {
    conditions.push(
      or(
        ilike(patentsTable.title, `%${q}%`),
        ilike(patentsTable.abstract, `%${q}%`),
        ilike(patentsTable.ideaText, `%${q}%`),
        ilike(patentsTable.patentNumber, `%${q}%`),
      ),
    );
  }
  if (domain) {
    conditions.push(ilike(patentsTable.technicalDomain, `%${domain}%`));
  }
  if (status) {
    conditions.push(eq(patentsTable.status, status));
  }
  if (conditions.length > 0) {
    baseQuery = baseQuery.where(or(...conditions));
  }

  const patents = await baseQuery.orderBy(desc(patentsTable.createdAt));
  res.json(SearchPatentsResponse.parse(patents));
});

router.post("/patents/formality-check", async (req, res): Promise<void> => {
  const parsed = FormalityCheckBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { ideaText, title, claims, applicantName, inventorName } = parsed.data;

  const prompt = `You are an AI Patent Formality Checker. Evaluate the following patent application fields for formality compliance.

Patent Application:
- Idea/Description: ${ideaText || "NOT PROVIDED"}
- Title: ${title || "NOT PROVIDED"}
- Claims: ${claims || "NOT PROVIDED"}
- Applicant Name: ${applicantName || "NOT PROVIDED"}
- Inventor Name: ${inventorName || "NOT PROVIDED"}

Return ONLY valid JSON with this exact structure:
{
  "passed": <boolean, true if score >= 60>,
  "score": <number 0-100>,
  "issues": ["list of specific formality issues found"],
  "suggestions": ["list of specific improvement suggestions"]
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const content = completion.choices[0]?.message?.content ?? "{}";
    const cleaned = content
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    res.json(FormalityCheckResponse.parse(JSON.parse(cleaned)));
  } catch (err) {
    req.log.error({ err }, "Formality check failed");
    res.status(500).json({ error: "Formality check failed. Please try again." });
  }
});

router.post("/patents/similarity", async (req, res): Promise<void> => {
  const parsed = SimilarityCheckBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { ideaText } = parsed.data;
  const allPatents = await db
    .select()
    .from(patentsTable)
    .orderBy(desc(patentsTable.createdAt))
    .limit(50);

  if (allPatents.length === 0) {
    res.json([]);
    return;
  }

  const patentList = allPatents
    .map(
      (p: any, i: number) =>
        `[${i}] Title: "${p.title}" | Domain: ${p.technicalDomain} | Keywords: ${(p.keywords as string[]).join(", ")}`,
    )
    .join("\n");

  const prompt = `You are a patent similarity analyzer. Compare a new invention idea against existing patents.

New Invention: ${ideaText}

Existing Patents:
${patentList}

Return ONLY valid JSON array (max 5 results, only similarity > 20%):
[{"patentIndex": <index>, "similarityScore": <0-100>, "matchingKeywords": ["overlapping keywords"]}]
If none match, return [].`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const content = completion.choices[0]?.message?.content ?? "[]";
    const cleaned = content
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const matches: {
      patentIndex: number;
      similarityScore: number;
      matchingKeywords: string[];
    }[] = JSON.parse(cleaned);

    const results = matches
      .filter((m) => m.patentIndex >= 0 && m.patentIndex < allPatents.length)
      .map((m) => ({
        patent: allPatents[m.patentIndex],
        similarityScore: m.similarityScore,
        matchingKeywords: m.matchingKeywords,
      }))
      .sort((a, b) => b.similarityScore - a.similarityScore);

    res.json(SimilarityCheckResponse.parse(results));
  } catch (err) {
    req.log.error({ err }, "Similarity check failed");
    res.status(500).json({ error: "Similarity check failed. Please try again." });
  }
});

router.post("/patents/analyze", async (req, res): Promise<void> => {
  const parsed = AnalyzePatentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { ideaText, applicantName, inventorName, claims } = parsed.data;
  req.log.info("Analyzing patent application");

  const systemPrompt = `You are an AI Patent Examination Assistant working for a modern patent office. Analyze patent applications professionally like a senior government patent examiner. Return ONLY valid JSON — no markdown, no code fences, no extra text.`;

  const userPrompt = `Analyze the following patent application and return a JSON object with exactly these fields:
{
  "title": "A professional patent-style title",
  "abstract": "A detailed technical abstract (2-3 sentences)",
  "technicalDomain": "One of: Artificial Intelligence, Machine Learning, Biotechnology, Medical Devices, Software, Electronics, Mechanical Engineering, Chemistry, Materials Science, Telecommunications, Energy, Nanotechnology, Robotics, Cybersecurity, or another specific domain",
  "keywords": ["array", "of", "5-8", "technical", "keywords"],
  "innovationAnalysis": "Detailed analysis (3-4 sentences covering technical merit, novelty, and differentiators from existing patents)",
  "noveltyScore": <number 0-100>,
  "patentStrengthScore": <number 0-100>,
  "weaknesses": ["array", "of", "2-4", "specific", "weaknesses"],
  "improvements": ["array", "of", "2-4", "specific", "improvement suggestions"],
  "recommendation": "One of: 'Strong candidate for patent filing', 'Viable with improvements', 'Significant prior art concerns — further research needed', or 'Not recommended for patent filing'",
  "formalityScore": <number 0-100, based on completeness of the application>,
  "formalityIssues": ["list of formality issues found, empty array if none"]
}

Application:
Description: ${ideaText}
${claims ? `Claims: ${claims}` : "Claims: Not provided"}
${applicantName ? `Applicant: ${applicantName}` : ""}
${inventorName ? `Inventor: ${inventorName}` : ""}`;

  let analysisData: {
    title: string;
    abstract: string;
    technicalDomain: string;
    keywords: string[];
    innovationAnalysis: string;
    noveltyScore: number;
    patentStrengthScore: number;
    weaknesses: string[];
    improvements: string[];
    recommendation: string;
    formalityScore: number;
    formalityIssues: string[];
  };

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 8192,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const content = completion.choices[0]?.message?.content ?? "{}";
    const cleaned = content
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    analysisData = JSON.parse(cleaned);
  } catch (err) {
    req.log.error({ err }, "AI analysis failed");
    res.status(500).json({ error: "AI analysis failed. Please try again." });
    return;
  }

  const [patent] = await db
    .insert(patentsTable)
    .values({
      patentNumber: generatePatentNumber(),
      applicantName: applicantName ?? null,
      inventorName: inventorName ?? null,
      claims: claims ?? null,
      ideaText,
      title: analysisData.title,
      abstract: analysisData.abstract,
      technicalDomain: analysisData.technicalDomain,
      keywords: analysisData.keywords,
      innovationAnalysis: analysisData.innovationAnalysis,
      noveltyScore: analysisData.noveltyScore,
      patentStrengthScore: analysisData.patentStrengthScore,
      weaknesses: analysisData.weaknesses,
      improvements: analysisData.improvements,
      recommendation: analysisData.recommendation,
      status: PatentStatus.SUBMITTED,
      formalityScore: analysisData.formalityScore,
      formalityIssues: analysisData.formalityIssues,
    })
    .returning();

  req.log.info({ patentId: patent!.id }, "Patent analysis created");
  res.status(201).json(GetPatentResponse.parse(patent));
});

router.get("/patents/:id", async (req, res): Promise<void> => {
  const params = GetPatentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [patent] = await db
    .select()
    .from(patentsTable)
    .where(eq(patentsTable.id, params.data.id));

  if (!patent) {
    res.status(404).json({ error: "Patent not found" });
    return;
  }

  res.json(GetPatentResponse.parse(patent));
});

router.patch("/patents/:id/status", async (req, res): Promise<void> => {
  const params = UpdatePatentStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdatePatentStatusBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [patent] = await db
    .update(patentsTable)
    .set({ status: body.data.status, updatedAt: new Date() })
    .where(eq(patentsTable.id, params.data.id))
    .returning();

  if (!patent) {
    res.status(404).json({ error: "Patent not found" });
    return;
  }

  req.log.info({ patentId: patent.id, status: patent.status }, "Patent status updated");
  res.json(UpdatePatentStatusResponse.parse(patent));
});

router.delete("/patents/:id", async (req, res): Promise<void> => {
  const params = DeletePatentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [patent] = await db
    .delete(patentsTable)
    .where(eq(patentsTable.id, params.data.id))
    .returning();

  if (!patent) {
    res.status(404).json({ error: "Patent not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
