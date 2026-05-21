import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, trademarksTable } from "@workspace/db";
import {
  ListTrademarksResponse,
  CreateTrademarkBody,
  GetTrademarkParams,
  GetTrademarkResponse,
  CheckTrademarkBody,
  CheckTrademarkResponse,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

router.get("/trademarks", async (_req, res): Promise<void> => {
  const trademarks = await db
    .select()
    .from(trademarksTable)
    .orderBy(desc(trademarksTable.createdAt));
  res.json(ListTrademarksResponse.parse(trademarks));
});

router.post("/trademarks", async (req, res): Promise<void> => {
  const parsed = CreateTrademarkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [trademark] = await db
    .insert(trademarksTable)
    .values({
      trademarkName: parsed.data.trademarkName,
      owner: parsed.data.owner,
      category: parsed.data.category,
      status: "pending",
      description: parsed.data.description ?? null,
    })
    .returning();

  res.status(201).json(GetTrademarkResponse.parse(trademark));
});

router.post("/trademarks/check", async (req, res): Promise<void> => {
  const parsed = CheckTrademarkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { trademarkName, category } = parsed.data;

  const existingTrademarks = await db
    .select()
    .from(trademarksTable)
    .where(eq(trademarksTable.status, "active"))
    .limit(100);

  const trademarkList = existingTrademarks
    .map(
      (t: any, i: number) =>
        `[${i}] Name: "${t.trademarkName}" | Owner: ${t.owner} | Category: ${t.category}`,
    )
    .join("\n");

  const prompt = `You are an AI Trademark Conflict Checker for a patent office. Analyze potential trademark conflicts.

New Trademark Application:
- Name: "${trademarkName}"
${category ? `- Category: ${category}` : ""}

Registered Active Trademarks:
${trademarkList || "No registered trademarks found."}

Return ONLY valid JSON with this exact structure:
{
  "available": <boolean, true if no significant conflicts>,
  "riskScore": <number 0-100, 0=no risk, 100=high conflict risk>,
  "conflicts": [
    {
      "trademarkIndex": <index from list>,
      "similarityScore": <0-100>,
      "reason": "specific reason for conflict"
    }
  ],
  "recommendation": "Clear assessment and recommendation for the applicant"
}

Consider phonetic similarity, visual similarity, same category conflicts, and potential consumer confusion.`;

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

    const aiResult: {
      available: boolean;
      riskScore: number;
      conflicts: { trademarkIndex: number; similarityScore: number; reason: string }[];
      recommendation: string;
    } = JSON.parse(cleaned);

    const conflicts = aiResult.conflicts
      .filter(
        (c) =>
          c.trademarkIndex >= 0 && c.trademarkIndex < existingTrademarks.length,
      )
      .map((c) => ({
        trademark: existingTrademarks[c.trademarkIndex],
        similarityScore: c.similarityScore,
        reason: c.reason,
      }));

    res.json(
      CheckTrademarkResponse.parse({
        available: aiResult.available,
        riskScore: aiResult.riskScore,
        conflicts,
        recommendation: aiResult.recommendation,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "Trademark check failed");
    res.status(500).json({ error: "Trademark check failed. Please try again." });
  }
});

router.get("/trademarks/:id", async (req, res): Promise<void> => {
  const params = GetTrademarkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [trademark] = await db
    .select()
    .from(trademarksTable)
    .where(eq(trademarksTable.id, params.data.id));

  if (!trademark) {
    res.status(404).json({ error: "Trademark not found" });
    return;
  }

  res.json(GetTrademarkResponse.parse(trademark));
});

export default router;
