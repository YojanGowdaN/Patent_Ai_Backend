export const PatentStatus = {
  SUBMITTED: "submitted",
  UNDER_AI_REVIEW: "under_ai_review",
  FORMALITY_CHECK: "formality_check",
  EXAMINER_REVIEW: "examiner_review",
  REQUIRES_MODIFICATION: "requires_modification",
  APPROVED: "approved",
  REJECTED: "rejected",
} as const;

export const patentsTable = {
  id: {} as any,
  createdAt: {} as any,
  status: {} as any,
  technicalDomain: {} as any,
  title: {} as any,
  abstract: {} as any,
  ideaText: {} as any,
  patentNumber: {} as any,
  noveltyScore: {} as any,
  patentStrengthScore: {} as any,
  keywords: {} as any,
  applicantName: {} as any,
  inventorName: {} as any,
  claims: {} as any,
  innovationAnalysis: {} as any,
  weaknesses: {} as any,
  improvements: {} as any,
  recommendation: {} as any,
  formalityScore: {} as any,
  formalityIssues: {} as any,
  updatedAt: {} as any,
} as const;

export const trademarksTable = {
  id: {} as any,
  createdAt: {} as any,
  status: {} as any,
  trademarkName: {} as any,
  owner: {} as any,
  category: {} as any,
  description: {} as any,
} as const;

export const db: any = {};
