/**
 * Strict schemas for everything the AI layer produces (README §11, Rule 9).
 *
 * Deliberately flat and total: every field is required and non-nullable so the
 * schema can be handed to provider-side structured output unchanged. "Unknown"
 * is expressed as an empty string / zero and normalized to `null` at the
 * database boundary by `toDbShape`.
 */
import { z } from "zod";
import { LeadCategory } from "@/src/generated/prisma/enums";

export const URGENCY_VALUES = ["UNKNOWN", "LOW", "MEDIUM", "HIGH"] as const;

/** Derived from the Prisma enum so the taxonomy cannot drift from the database. */
export const LeadCategorySchema = z.enum(LeadCategory);
export const UrgencySchema = z.enum(URGENCY_VALUES);

/** Cheap first-stage screen (README §32/§33). */
export const ScreenResultSchema = z.object({
  isCandidate: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300),
});
export type ScreenResult = z.infer<typeof ScreenResultSchema>;

/** Budget: 0 / "" mean "not stated". */
export const BudgetSchema = z.object({
  min: z.number().int().min(0).max(10_000_000),
  max: z.number().int().min(0).max(10_000_000),
  currency: z.string().max(8),
});

/** Full structured analysis (README §11). */
export const LeadAnalysisSchema = z.object({
  isLead: z.boolean(),
  confidence: z.number().min(0).max(1),
  category: LeadCategorySchema,
  projectDescription: z.string().max(600),
  intentScore: z.number().int().min(0).max(100),
  budget: BudgetSchema,
  urgency: UrgencySchema,
  location: z.string().max(120),
  businessType: z.string().max(120),
  requirements: z.array(z.string().max(200)).max(12),
  painPoints: z.array(z.string().max(200)).max(12),
  recommendedService: z.string().max(200),
  reasoning: z.string().max(1200),
});
export type LeadAnalysis = z.infer<typeof LeadAnalysisSchema>;

/** Shape used to render a lead into a prompt payload. */
export type LeadPromptInput = {
  title?: string | null;
  content: string;
  sourceKind: string;
  sourceAuthor?: string | null;
  sourceCreatedAt?: Date | null;
  sourceUrl?: string | null;
};

/** Facts about the owner that may be used when drafting a response (README §16). */
export type OwnerProfileFacts = {
  name: string;
  services: string[];
  experience: string | null;
  location: string | null;
  languages: string[];
  minimumBudget: number | null;
  portfolio: Array<{ title?: string; url?: string; description?: string }>;
  tone: string | null;
};

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function zeroToNull(value: number | null | undefined): number | null {
  return typeof value === "number" && value > 0 ? Math.round(value) : null;
}

/** Normalizes validated AI output into database-friendly values. */
export function toDbShape(analysis: LeadAnalysis) {
  const min = zeroToNull(analysis.budget.min);
  const max = zeroToNull(analysis.budget.max);
  const currency = blankToNull(analysis.budget.currency);

  return {
    projectDescription: blankToNull(analysis.projectDescription),
    budgetMin: min,
    budgetMax: max === null ? min : max,
    budgetCurrency: currency === null ? null : currency.toUpperCase(),
    location: blankToNull(analysis.location),
    businessType: blankToNull(analysis.businessType),
    requirements: analysis.requirements.map((r) => r.trim()).filter(Boolean),
    painPoints: analysis.painPoints.map((p) => p.trim()).filter(Boolean),
    recommendedService: blankToNull(analysis.recommendedService),
  };
}
