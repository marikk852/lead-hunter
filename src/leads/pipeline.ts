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
import { BudgetExceededError, getAIProvider } from "@/src/ai";
import { PROMPT_VERSION } from "@/src/ai/prompts";
import type { ScreenOutcome } from "@/src/ai/types";
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
  /** Saved query that produced this item (discovery provenance). */
  searchQueryId?: string | null;
  /**
   * Run the cheap first-stage screen before the full analysis. Defaults to on,
   * except for manual entry: the owner pasted that post deliberately, so it is
   * analysed in full rather than filtered by a model.
   */
  screen?: boolean;
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
 * Prisma's unique-constraint violation (`PrismaClientKnownRequestError`).
 * Duck-typed on purpose: the generated client is an implementation detail the
 * pipeline does not otherwise import.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
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

  let lead: { id: string };
  try {
    lead = await prisma.lead.create({
      data: {
        sourceId: source.id,
        sourceExternalId: input.sourceExternalId ?? null,
        sourceUrl: input.sourceUrl ?? null,
        sourceAuthor: input.sourceAuthor ?? null,
        sourceCreatedAt: input.sourceCreatedAt ?? null,
        title: input.title ?? null,
        originalContent: content,
        contentHash: hash,
        searchQueryId: input.searchQueryId ?? null,
      },
    });
  } catch (error) {
    // Lost the insert race on @@unique([sourceId, sourceExternalId]): two runs
    // found the same external post at the same moment and the other one won.
    // Ingestion has to be idempotent (§6) — the second arrival attaches to the
    // first record instead of crashing the scan with a constraint error.
    if (!isUniqueViolation(error) || !input.sourceExternalId) throw error;

    const winner = await prisma.lead.findFirst({
      where: { sourceId: source.id, sourceExternalId: input.sourceExternalId },
      select: { id: true },
    });
    if (!winner) throw error;

    await prisma.leadEvent.create({
      data: {
        leadId: winner.id,
        type: EventType.DEDUPLICATED,
        message: `Duplicate candidate ignored (${describeDedupeReason({ code: "sameSourceItem" })})`,
        metadata: {
          reason: "sameSourceItem",
          sourceKind: source.kind,
          excerpt: excerpt(content),
        },
      },
    });
    logger.info("duplicate lead ignored (insert race won by another run)", {
      leadId: winner.id,
    });
    return {
      outcome: "duplicate",
      leadId: winner.id,
      reason: { code: "sameSourceItem" },
      similarity: 1,
    };
  }

  await prisma.leadEvent.create({
    data: {
      leadId: lead.id,
      type: EventType.DISCOVERED,
      message: `Lead discovered via ${source.kind.toLowerCase()} source "${source.name}"`,
      metadata: {
        sourceAuthor: input.sourceAuthor ?? null,
        sourceUrl: input.sourceUrl ?? null,
        searchQueryId: input.searchQueryId ?? null,
      },
    },
  });

  const promptInput = toPromptInput({ ...input, content }, source.kind);
  return analyzeLeadInternal(lead.id, promptInput, {
    screen: input.screen ?? source.kind !== SourceKind.MANUAL,
  });
}

/**
 * Runs (or re-runs) AI analysis for an existing lead and recomputes its score.
 */
export async function analyzeLeadInternal(
  leadId: string,
  promptInput: LeadPromptInput,
  options: { screen?: boolean } = {},
): Promise<IngestResult> {
  const provider = getAIProvider();
  const profile = await getOwnerProfile();

  let providerName = provider.name;
  let model = "unknown";
  let notes: string[] = [];
  let warning: IngestWarningCode | undefined;

  // Stage A (SPEC §9 two-layer discovery): a cheap screen decides whether the
  // expensive full analysis is worth buying. A screened-out post is stored and
  // archived with the screen's own reason, so the owner can overturn it — it is
  // never silently dropped, and it never reaches the FULL model call.
  if (options.screen !== false && provider.screen) {
    try {
      const screened: ScreenOutcome = await provider.screen(promptInput);
      await prisma.aIAnalysis.create({
        data: {
          leadId,
          provider: screened.provider,
          model: screened.model,
          promptVersion: screened.promptVersion,
          stage: AnalysisStage.SCREEN,
          raw: (screened.raw ?? {}) as object,
          parsed: screened.screen as unknown as object,
          usage: (screened.usage ?? undefined) as object | undefined,
          status: "SUCCEEDED",
        },
      });

      if (!screened.screen.isCandidate) {
        const reason = screened.screen.reason.trim() || "Screened out before full analysis.";
        await prisma.$transaction([
          prisma.lead.update({
            where: { id: leadId },
            data: {
              analysisStatus: "SKIPPED",
              aiModel: `${screened.provider}:${screened.model}`,
              aiProcessedAt: new Date(),
              leadScore: 0,
              temperature: "COLD",
              status: "ARCHIVED",
              scoreBreakdown: {
                total: 0,
                temperature: "COLD",
                stage: "SCREEN",
                confidence: screened.screen.confidence,
                reason,
                notes: screened.notes,
              } as unknown as object,
            },
          }),
          prisma.leadEvent.create({
            data: {
              leadId,
              type: EventType.ANALYZED,
              message: `Screened out by ${screened.provider} (${screened.model}) before full analysis: ${reason}`,
              metadata: {
                stage: "SCREEN",
                isCandidate: false,
                confidence: screened.screen.confidence,
                usage: screened.usage ?? null,
              } as object,
            },
          }),
        ]);

        logger.info("lead screened out", {
          leadId,
          provider: screened.provider,
          model: screened.model,
          confidence: screened.screen.confidence,
        });

        return {
          outcome: "created",
          leadId,
          score: 0,
          temperature: "COLD",
          analysisStatus: "SKIPPED",
        };
      }

      notes = screened.notes;
    } catch (error) {
      // A broken screen must not cost a discovery: fall through to the full
      // analysis and record that the cheap stage did not run.
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`screen failed, continued to full analysis: ${message}`);
      logger.warn("lead screen failed; continuing to full analysis", { leadId, error: message });
    }
  }

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
    // The daily ceiling is not a per-lead failure: every further item would hit
    // the same wall. Rethrow so the hunt runner can stop the whole scan instead
    // of buying (and failing) one call per remaining post.
    if (error instanceof BudgetExceededError) throw error;

    const message = error instanceof Error ? error.message : String(error);

    await prisma.aIAnalysis.create({
      data: {
        leadId,
        provider: providerName,
        model,
        promptVersion: PROMPT_VERSION,
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

  return analyzeLeadInternal(
    leadId,
    {
      title: lead.title,
      content: lead.originalContent,
      sourceKind: lead.source.kind,
      sourceAuthor: lead.sourceAuthor,
      sourceCreatedAt: lead.sourceCreatedAt,
      sourceUrl: lead.sourceUrl,
    },
    // The owner asked for a full re-run explicitly; do not let the screen
    // silently override that decision.
    { screen: false },
  );
}
