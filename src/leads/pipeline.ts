/**
 * The lead pipeline: ingest → deduplicate → analyze → score → persist.
 *
 * This is the vertical slice the README asks for (§44): one function turns raw
 * text into a scored, analysed lead that the dashboard can render, with an
 * activity trail explaining what happened.
 *
 * Long scans do not belong here — the pipeline is per-item so it can be driven
 * by a request today and by a queue worker in Phase 2 (§28) without changes.
 */
import { getAIProvider } from "@/src/ai";
import { toDbShape, type LeadAnalysis, type LeadPromptInput } from "@/src/ai/schemas";
import { AIProviderError } from "@/src/ai/types";
import { AnalysisStage, EventType, SourceKind } from "@/src/generated/prisma/enums";
import {
  decideDuplicate,
  describeDedupeReason,
  type DedupeCandidate,
  type DedupeReason,
} from "@/src/leads/dedupe";
import { scoreLead } from "@/src/leads/scoring";
import { prisma } from "@/src/lib/db";
import { logger } from "@/src/lib/logger";
import { contentHash, excerpt } from "@/src/lib/text";
import { getOwnerProfile } from "@/src/profile";

export const MANUAL_SOURCE_NAME = "Manual entry";
export const MAX_CONTENT_LENGTH = 20_000;

export type IngestInput = {
  content: string;
  title?: string | null;
  sourceAuthor?: string | null;
  sourceUrl?: string | null;
  sourceExternalId?: string | null;
  sourceCreatedAt?: Date | null;
  /** Attach to an existing Source row (Phase 2 adapters); otherwise a manual source is used. */
  sourceId?: string;
  sourceKind?: SourceKind;
  sourceName?: string;
  analysisPromptVersion?: string;
};

export type IngestResult =
  | {
      outcome: "created";
      leadId: string;
      score: number;
      temperature: string;
      analysisStatus: string;
      /** Set when the lead was stored but its analysis failed. */
      warning?: IngestWarningCode;
    }
  | {
      outcome: "duplicate";
      leadId: string;
      reason: DedupeReason;
      similarity: number;
    }
  // Codes, never user-facing prose: the UI renders them in the owner's language,
  // and they are safe to carry in a redirect URL.
  | { outcome: "invalid"; code: IngestErrorCode };

export type IngestErrorCode = "contentEmpty" | "contentTooLong" | "notFound";
export type IngestWarningCode = "analysisFailed";

/** Resolves (or creates) the Source row a lead belongs to. */
async function resolveSource(input: IngestInput) {
  if (input.sourceId) {
    const existing = await prisma.source.findUnique({ where: { id: input.sourceId } });
    if (!existing) throw new Error(`Unknown sourceId: ${input.sourceId}`);
    return existing;
  }

  const adapter = (input.sourceKind ?? SourceKind.MANUAL).toLowerCase();
  const name = input.sourceName ?? MANUAL_SOURCE_NAME;

  return prisma.source.upsert({
    where: { adapter_name: { adapter, name } },
    update: {},
    create: { adapter, name, kind: input.sourceKind ?? SourceKind.MANUAL, config: {} },
  });
}

/**
 * Candidate pool for duplicate detection. Bounded on purpose: comparing against
 * a few hundred recent leads is enough for this tool's volume and keeps the
 * check off the critical path. Exact-hash matches are always included.
 */
async function findDedupeCandidates(hash: string, now: Date): Promise<DedupeCandidate[]> {
  const since = new Date(now.getTime() - 120 * 86_400_000);

  const [byHash, recent] = await Promise.all([
    prisma.lead.findMany({
      where: { contentHash: hash },
      select: {
        id: true,
        sourceId: true,
        sourceExternalId: true,
        sourceAuthor: true,
        contentHash: true,
        originalContent: true,
      },
      take: 5,
    }),
    prisma.lead.findMany({
      where: { createdAt: { gte: since }, duplicateOfId: null },
      orderBy: { createdAt: "desc" },
      take: 300,
      select: {
        id: true,
        sourceId: true,
        sourceExternalId: true,
        sourceAuthor: true,
        contentHash: true,
        originalContent: true,
      },
    }),
  ]);

  const seen = new Set<string>();
  return [...byHash, ...recent].filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function toPromptInput(
  input: IngestInput,
  sourceKind: string,
): LeadPromptInput {
  return {
    title: input.title ?? null,
    content: input.content,
    sourceKind,
    sourceAuthor: input.sourceAuthor ?? null,
    sourceCreatedAt: input.sourceCreatedAt ?? null,
    sourceUrl: input.sourceUrl ?? null,
  };
}

/**
 * Ingests one candidate. Never throws for analysis problems: a failed AI call
 * leaves a REVIEWABLE lead behind instead of losing the discovery (§36).
 */
export async function ingestLead(input: IngestInput, now: Date = new Date()): Promise<IngestResult> {
  const content = input.content?.trim() ?? "";
  if (content.length === 0) return { outcome: "invalid", code: "contentEmpty" };
  if (content.length > MAX_CONTENT_LENGTH) {
    return { outcome: "invalid", code: "contentTooLong" };
  }

  const source = await resolveSource(input);
  const hash = contentHash(content);

  const candidates = await findDedupeCandidates(hash, now);
  const decision = decideDuplicate(
    {
      sourceId: source.id,
      sourceExternalId: input.sourceExternalId ?? null,
      sourceAuthor: input.sourceAuthor ?? null,
      contentHash: hash,
      originalContent: content,
    },
    candidates,
  );

  if (decision.duplicateOfId) {
    await prisma.leadEvent.create({
      data: {
        leadId: decision.duplicateOfId,
        type: EventType.DEDUPLICATED,
        message: `Duplicate candidate ignored (${describeDedupeReason(decision.reason)})`,
        metadata: {
          reason: decision.reason.code,
          ...("percent" in decision.reason ? { percent: decision.reason.percent } : {}),
          similarity: decision.similarity,
          sourceKind: source.kind,
          excerpt: excerpt(content),
        },
      },
    });
    logger.info("duplicate lead ignored", {
      duplicateOfId: decision.duplicateOfId,
      similarity: decision.similarity,
    });
    return {
      outcome: "duplicate",
      leadId: decision.duplicateOfId,
      reason: decision.reason,
      similarity: decision.similarity,
    };
  }

  const lead = await prisma.lead.create({
    data: {
      sourceId: source.id,
      sourceExternalId: input.sourceExternalId ?? null,
      sourceUrl: input.sourceUrl ?? null,
      sourceAuthor: input.sourceAuthor ?? null,
      sourceCreatedAt: input.sourceCreatedAt ?? null,
      title: input.title ?? null,
      originalContent: content,
      contentHash: hash,
    },
  });

  await prisma.leadEvent.create({
    data: {
      leadId: lead.id,
      type: EventType.DISCOVERED,
      message: `Lead discovered via ${source.kind.toLowerCase()} source "${source.name}"`,
      metadata: { sourceAuthor: input.sourceAuthor ?? null, sourceUrl: input.sourceUrl ?? null },
    },
  });

  const promptInput = toPromptInput({ ...input, content }, source.kind);
  return analyzeLeadInternal(lead.id, promptInput);
}

/**
 * Runs (or re-runs) AI analysis for an existing lead and recomputes its score.
 */
export async function analyzeLeadInternal(
  leadId: string,
  promptInput: LeadPromptInput,
): Promise<IngestResult> {
  const provider = getAIProvider();
  const profile = await getOwnerProfile();

  let providerName = provider.name;
  let model = "unknown";
  let notes: string[] = [];
  let warning: IngestWarningCode | undefined;

  try {
    const outcome = await provider.analyzeLead(promptInput);
    providerName = outcome.provider;
    model = outcome.model;
    notes = outcome.notes;

    const analysis: LeadAnalysis = outcome.analysis;
    const dbShape = toDbShape(analysis);
    const scored = scoreLead(
      analysis,
      {
        sourceAuthor: promptInput.sourceAuthor,
        sourceUrl: promptInput.sourceUrl,
        sourceCreatedAt: promptInput.sourceCreatedAt,
      },
      profile,
    );

    // A non-lead is archived rather than deleted: the owner can still see and
    // overturn the decision (§4 "LOW SCORE → Archive").
    const status = analysis.isLead ? undefined : "ARCHIVED";

    await prisma.$transaction([
      prisma.aIAnalysis.create({
        data: {
          leadId,
          provider: outcome.provider,
          model: outcome.model,
          promptVersion: outcome.promptVersion,
          stage: AnalysisStage.FULL,
          raw: (outcome.raw ?? {}) as object,
          parsed: analysis as unknown as object,
          usage: (outcome.usage ?? undefined) as object | undefined,
          status: "SUCCEEDED",
        },
      }),
      prisma.lead.update({
        where: { id: leadId },
        data: {
          category: analysis.category,
          projectDescription: dbShape.projectDescription,
          intentScore: analysis.intentScore,
          leadScore: scored.total,
          temperature: scored.temperature,
          budgetMin: dbShape.budgetMin,
          budgetMax: dbShape.budgetMax,
          budgetCurrency: dbShape.budgetCurrency,
          urgency: analysis.urgency,
          location: dbShape.location,
          businessType: dbShape.businessType,
          requirements: dbShape.requirements,
          painPoints: dbShape.painPoints,
          aiAnalysis: analysis as unknown as object,
          aiModel: `${outcome.provider}:${outcome.model}`,
          aiProcessedAt: new Date(),
          analysisStatus: "SUCCEEDED",
          scoreBreakdown: {
            total: scored.total,
            temperature: scored.temperature,
            components: scored.components,
            confidence: analysis.confidence,
            recommendedService: dbShape.recommendedService,
            notes,
          } as unknown as object,
          ...(status ? { status } : {}),
        },
      }),
      prisma.leadEvent.create({
        data: {
          leadId,
          type: EventType.ANALYZED,
          message: `Analyzed by ${outcome.provider} (${outcome.model}) — ${
            analysis.isLead ? "qualified as a lead" : "not a lead"
          }`,
          metadata: {
            confidence: analysis.confidence,
            intentScore: analysis.intentScore,
            notes,
            usage: outcome.usage ?? null,
          } as object,
        },
      }),
      prisma.leadEvent.create({
        data: {
          leadId,
          type: EventType.SCORED,
          message: `Scored ${scored.total}/100 (${scored.temperature})`,
          metadata: { components: scored.components } as object,
        },
      }),
    ]);

    logger.info("lead analyzed", {
      leadId,
      provider: outcome.provider,
      model: outcome.model,
      score: scored.total,
      temperature: scored.temperature,
      isLead: analysis.isLead,
    });

    return {
      outcome: "created",
      leadId,
      score: scored.total,
      temperature: scored.temperature,
      analysisStatus: "SUCCEEDED",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await prisma.aIAnalysis.create({
      data: {
        leadId,
        provider: providerName,
        model,
        promptVersion: promptInput.sourceKind,
        stage: AnalysisStage.FULL,
        status: "FAILED",
        error: message,
      },
    });

    await prisma.lead.update({
      where: { id: leadId },
      data: { analysisStatus: "FAILED" },
    });

    await prisma.leadEvent.create({
      data: {
        leadId,
        type: EventType.NOTE,
        message: `Analysis failed: ${message}`,
        metadata: { provider: providerName } as object,
      },
    });

    logger.error("lead analysis failed", {
      leadId,
      provider: providerName,
      error: message,
      aiProviderError: error instanceof AIProviderError,
    });

    // The provider's own error text stays in the log and in the AI-run row; the
    // banner only needs to say that the analysis failed.
    warning = "analysisFailed";
    return {
      outcome: "created",
      leadId,
      score: 0,
      temperature: "COLD",
      analysisStatus: "FAILED",
      warning,
    };
  }
}

/** Re-runs analysis for a stored lead. */
export async function reanalyzeLead(leadId: string): Promise<IngestResult> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { source: true },
  });
  if (!lead) return { outcome: "invalid", code: "notFound" };

  return analyzeLeadInternal(leadId, {
    title: lead.title,
    content: lead.originalContent,
    sourceKind: lead.source.kind,
    sourceAuthor: lead.sourceAuthor,
    sourceCreatedAt: lead.sourceCreatedAt,
    sourceUrl: lead.sourceUrl,
  });
}
