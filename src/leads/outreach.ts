/**
 * Outreach, status transitions and follow-ups (README §15, §17, §18).
 *
 * NOTHING here sends a message. It only drafts, records and schedules. The
 * owner approves and sends out of band — the MVP must never become a spam bot.
 */
import { getAIProvider } from "@/src/ai";
import type { LeadAnalysis } from "@/src/ai/schemas";
import { LeadAnalysisSchema } from "@/src/ai/schemas";
import { EventType, LeadStatus, OutreachChannel, OutreachStatus } from "@/src/generated/prisma/enums";
import { prisma } from "@/src/lib/db";
import { logger } from "@/src/lib/logger";
import { getOwnerProfile } from "@/src/profile";

export const FOLLOW_UP_DELAY_DAYS = 3;

/**
 * Domain failures carry a stable code (plus optional params) instead of prose,
 * so the UI can render them in the owner's language.
 */
export class OutreachError extends Error {
  constructor(
    readonly code: OutreachErrorCode,
    readonly params: Record<string, string | number> = {},
  ) {
    super(code);
    this.name = "OutreachError";
  }
}

export type OutreachErrorCode =
  | "notFound"
  | "noAnalysis"
  | "emptyDraft"
  | "draftMissing"
  | "noteEmpty";

function channelFor(sourceKind: string): OutreachChannel {
  switch (sourceKind) {
    case "REDDIT":
      return OutreachChannel.REDDIT;
    case "TELEGRAM":
      return OutreachChannel.TELEGRAM;
    default:
      return OutreachChannel.OTHER;
  }
}

/** Reads the stored analysis back out of the lead, re-validating it. */
export function readStoredAnalysis(aiAnalysis: unknown): LeadAnalysis | null {
  const parsed = LeadAnalysisSchema.safeParse(aiAnalysis);
  return parsed.success ? parsed.data : null;
}

/**
 * Drafts a reply for a lead. The draft is written to `Outreach` as DRAFT and is
 * never sent automatically.
 */
export async function generateResponseDraft(leadId: string, adjust?: string | null) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { source: true } });
  if (!lead) throw new OutreachError("notFound");

  const analysis = readStoredAnalysis(lead.aiAnalysis);
  if (!analysis) throw new OutreachError("noAnalysis");

  const provider = getAIProvider();
  const profile = await getOwnerProfile();

  const outcome = await provider.generateResponse({
    lead: {
      title: lead.title,
      content: lead.originalContent,
      sourceKind: lead.source.kind,
      sourceAuthor: lead.sourceAuthor,
      sourceCreatedAt: lead.sourceCreatedAt,
      sourceUrl: lead.sourceUrl,
    },
    analysis,
    profile,
    adjust: adjust ?? null,
  });

  const outreach = await prisma.outreach.create({
    data: {
      leadId,
      channel: channelFor(lead.source.kind),
      body: outcome.body,
      status: OutreachStatus.DRAFT,
      model: `${outcome.provider}:${outcome.model}`,
    },
  });

  await prisma.leadEvent.create({
    data: {
      leadId,
      type: EventType.NOTE,
      message: `Response drafted by ${outcome.provider} (${outcome.model})`,
      metadata: { outreachId: outreach.id, notes: outcome.notes, usage: outcome.usage ?? null } as object,
    },
  });

  logger.info("response drafted", { leadId, provider: outcome.provider, model: outcome.model });
  return outreach;
}

export async function updateDraft(leadId: string, outreachId: string, body: string) {
  const trimmed = body.trim();
  if (trimmed.length === 0) throw new OutreachError("emptyDraft");

  const existing = await prisma.outreach.findFirst({ where: { id: outreachId, leadId } });
  if (!existing) throw new OutreachError("draftMissing");

  return prisma.outreach.update({
    where: { id: outreachId },
    data: { body: trimmed, status: OutreachStatus.APPROVED, model: "manual" },
  });
}

/**
 * Records that the owner sent the message themselves. Creates the follow-up
 * reminder because most first contacts get no reply.
 */
export async function markContacted(
  leadId: string,
  options: { outreachId?: string; channel?: OutreachChannel } = {},
  now: Date = new Date(),
) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { source: true } });
  if (!lead) throw new OutreachError("notFound");

  const dueAt = new Date(now.getTime() + FOLLOW_UP_DELAY_DAYS * 86_400_000);

  if (options.outreachId) {
    await prisma.outreach.updateMany({
      where: { id: options.outreachId, leadId },
      data: { status: OutreachStatus.SENT, sentAt: now },
    });
  }

  const followUp = await prisma.followUp.create({
    data: {
      leadId,
      dueAt,
      body: "No reply yet — a short follow-up is due.",
    },
  });

  await prisma.$transaction([
    prisma.lead.update({
      where: { id: leadId },
      data: { status: LeadStatus.CONTACTED },
    }),
    prisma.leadEvent.create({
      data: {
        leadId,
        type: EventType.CONTACTED,
        message: "Owner marked this lead as contacted",
        metadata: {
          channel: options.channel ?? channelFor(lead.source.kind),
          outreachId: options.outreachId ?? null,
        } as object,
      },
    }),
    prisma.leadEvent.create({
      data: {
        leadId,
        type: EventType.FOLLOWUP_SCHEDULED,
        message: `Follow-up reminder set for ${dueAt.toISOString().slice(0, 10)}`,
        metadata: { followUpId: followUp.id } as object,
      },
    }),
  ]);

  logger.info("lead marked contacted", { leadId, dueAt: dueAt.toISOString() });
  return { followUpId: followUp.id, dueAt };
}

export async function changeStatus(leadId: string, status: LeadStatus, note?: string) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new OutreachError("notFound");
  if (lead.status === status) return lead;

  const [updated] = await prisma.$transaction([
    prisma.lead.update({ where: { id: leadId }, data: { status } }),
    prisma.leadEvent.create({
      data: {
        leadId,
        type: eventForStatus(status),
        message: note ?? `Status changed from ${lead.status} to ${status}`,
        metadata: { from: lead.status, to: status } as object,
      },
    }),
  ]);

  logger.info("lead status changed", { leadId, from: lead.status, to: status });
  return updated;
}

function eventForStatus(status: LeadStatus): EventType {
  switch (status) {
    case LeadStatus.CONTACTED:
      return EventType.CONTACTED;
    case LeadStatus.REPLIED:
      return EventType.REPLIED;
    case LeadStatus.REVIEWED:
      return EventType.REVIEWED;
    default:
      return EventType.STATUS_CHANGED;
  }
}

export async function completeFollowUp(followUpId: string) {
  return prisma.followUp.update({
    where: { id: followUpId },
    data: { done: true, sentAt: new Date() },
  });
}

/** Owner note, shown in the activity timeline. */
export async function addNote(leadId: string, message: string) {
  const trimmed = message.trim();
  if (trimmed.length === 0) throw new OutreachError("noteEmpty");
  return prisma.leadEvent.create({
    data: { leadId, type: EventType.NOTE, message: trimmed },
  });
}

/** WON leads with a budget become revenue (README §22). */
export async function recordOutcome(leadId: string, won: boolean, amount?: number | null) {
  const status = won ? LeadStatus.WON : LeadStatus.LOST;
  const lead = await changeStatus(
    leadId,
    status,
    won ? "Project won" : "Opportunity lost",
  );

  if (typeof amount === "number" && amount >= 0) {
    await prisma.leadEvent.create({
      data: {
        leadId,
        type: EventType.STATUS_CHANGED,
        message: `Recorded value: ${amount} ${lead.budgetCurrency ?? ""}`.trim(),
        metadata: { amount, won } as object,
      },
    });
  }
  return lead;
}
