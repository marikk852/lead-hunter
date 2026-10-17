/**
 * Deterministic lead score (README §9, §10).
 *
 * The eight weighted factors below are exactly the ones in the spec. The LLM
 * supplies the judgement inputs (intent, budget, urgency...); this module turns
 * them into one comparable number, so scoring stays reproducible and testable
 * even though the analysis is not.
 */
import type { LeadAnalysis, OwnerProfileFacts } from "@/src/ai/schemas";
import { Temperature } from "@/src/generated/prisma/enums";

export const FACTOR_WEIGHTS = {
  intent: 30,
  clarity: 15,
  budget: 15,
  urgency: 15,
  legitimacy: 10,
  contactability: 5,
  recency: 5,
  fit: 5,
} as const;

export const HOT_THRESHOLD = 80;
export const WARM_THRESHOLD = 50;

/** A non-lead can never look attractive in the dashboard. */
export const NON_LEAD_CAP = 30;

export type ScoreContext = {
  sourceAuthor?: string | null;
  sourceUrl?: string | null;
  sourceCreatedAt?: Date | null;
};

export type ScoreComponent = {
  factor: keyof typeof FACTOR_WEIGHTS;
  /** Normalized 0-1 value of the factor. */
  normalized: number;
  weight: number;
  points: number;
};

export type ScoreResult = {
  total: number;
  temperature: Temperature;
  components: ScoreComponent[];
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clarityScore(analysis: LeadAnalysis): number {
  let score = 0;
  if (analysis.projectDescription.trim().length >= 20) score += 0.25;
  const requirements = analysis.requirements.length;
  if (requirements >= 3) score += 0.45;
  else if (requirements === 2) score += 0.35;
  else if (requirements === 1) score += 0.2;
  if (analysis.category !== "OTHER") score += 0.2;
  if (analysis.recommendedService.trim().length > 0) score += 0.1;
  return clamp01(score);
}

function budgetScore(analysis: LeadAnalysis, profile: OwnerProfileFacts): number {
  const stated = analysis.budget.max > 0 || analysis.budget.min > 0;
  if (!stated) return 0;

  let score = 0.6;
  const amount = Math.max(analysis.budget.min, analysis.budget.max);
  if (profile.minimumBudget && profile.minimumBudget > 0) {
    score += amount >= profile.minimumBudget ? 0.4 : 0.1;
  } else {
    score += 0.4;
  }
  return clamp01(score);
}

function urgencyScore(analysis: LeadAnalysis): number {
  switch (analysis.urgency) {
    case "HIGH":
      return 1;
    case "MEDIUM":
      return 0.6;
    case "LOW":
      return 0.3;
    default:
      return 0.4;
  }
}

function legitimacyScore(analysis: LeadAnalysis): number {
  let score = 0;
  if (analysis.businessType.trim().length > 0) score += 0.5;
  if (analysis.location.trim().length > 0) score += 0.2;
  if (analysis.projectDescription.trim().length >= 60) score += 0.3;
  return clamp01(score);
}

function contactabilityScore(context: ScoreContext): number {
  const hasAuthor = Boolean(context.sourceAuthor?.trim());
  const hasUrl = Boolean(context.sourceUrl?.trim());
  if (hasAuthor && hasUrl) return 1;
  if (hasAuthor || hasUrl) return 0.5;
  return 0.1;
}

/** Recency of the post itself, not of our discovery of it. */
export function recencyScore(sourceCreatedAt: Date | null | undefined, now: Date): number {
  if (!sourceCreatedAt) return 0.4;
  const days = (now.getTime() - sourceCreatedAt.getTime()) / 86_400_000;
  if (days <= 2) return 1;
  if (days <= 7) return 0.85;
  if (days <= 30) return 0.6;
  if (days <= 90) return 0.35;
  return 0.15;
}

/** How well the request matches what the owner actually sells. */
export function fitScore(analysis: LeadAnalysis, profile: OwnerProfileFacts): number {
  const services = profile.services.map((service) => service.toLowerCase());
  const haystack = `${analysis.category} ${analysis.recommendedService} ${analysis.projectDescription}`.toLowerCase();

  const matches = services.filter((service) => service.length > 2 && haystack.includes(service)).length;
  let score = 0.4;
  if (services.length === 0) score = 0.5;
  else if (matches >= 2) score = 1;
  else if (matches === 1) score = 0.8;

  if (profile.minimumBudget && analysis.budget.max > 0) {
    if (analysis.budget.max < profile.minimumBudget) score = Math.min(score, 0.3);
  }
  return clamp01(score);
}

export function temperatureFor(total: number): Temperature {
  if (total >= HOT_THRESHOLD) return Temperature.HOT;
  if (total >= WARM_THRESHOLD) return Temperature.WARM;
  return Temperature.COLD;
}

/** Combines analysis + context + owner profile into the 0-100 lead score. */
export function scoreLead(
  analysis: LeadAnalysis,
  context: ScoreContext,
  profile: OwnerProfileFacts,
  now: Date = new Date(),
): ScoreResult {
  const normalized: Record<keyof typeof FACTOR_WEIGHTS, number> = {
    intent: clamp01(analysis.intentScore / 100),
    clarity: clarityScore(analysis),
    budget: budgetScore(analysis, profile),
    urgency: urgencyScore(analysis),
    legitimacy: legitimacyScore(analysis),
    contactability: contactabilityScore(context),
    recency: recencyScore(context.sourceCreatedAt, now),
    fit: fitScore(analysis, profile),
  };

  const components: ScoreComponent[] = (
    Object.keys(FACTOR_WEIGHTS) as Array<keyof typeof FACTOR_WEIGHTS>
  ).map((factor) => {
    const weight = FACTOR_WEIGHTS[factor];
    return {
      factor,
      normalized: Number(normalized[factor].toFixed(3)),
      weight,
      points: Number((normalized[factor] * weight).toFixed(2)),
    };
  });

  let total = components.reduce((sum, component) => sum + component.points, 0);

  // The AI already decided this is not a buyer; keep it out of the HOT band
  // regardless of how attractive the rest of the profile looks.
  if (!analysis.isLead) total = Math.min(total, NON_LEAD_CAP);

  total = Math.round(Math.max(0, Math.min(100, total)));

  return { total, temperature: temperatureFor(total), components };
}
