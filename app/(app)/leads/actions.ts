"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/src/auth/session";
import { LeadStatus, OutreachChannel, SourceKind } from "@/src/generated/prisma/enums";
import {
  OutreachError,
  addNote,
  changeStatus,
  completeFollowUp,
  generateResponseDraft,
  markContacted,
  recordOutcome,
  updateDraft,
} from "@/src/leads/outreach";
import { ingestLead, reanalyzeLead } from "@/src/leads/pipeline";
import { BudgetExceededError } from "@/src/ai";
import { logger } from "@/src/lib/logger";

/**
 * Server Actions are reachable by direct POST, so every one of them re-checks
 * the session before touching data.
 *
 * They also fail with *codes*, never sentences: the screen renders the code in
 * the owner's language, and a code is always safe to put in a redirect URL (an
 * English message containing a `%` used to break the duplicate banner).
 */

function revalidateLead(id: string) {
  revalidatePath("/leads");
  revalidatePath("/dashboard");
  revalidatePath(`/leads/${id}`);
}

function parseDate(value: string): Date | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function createLeadAction(formData: FormData): Promise<void> {
  await requireOwner();

  const content = String(formData.get("content") ?? "").trim();
  if (content.length === 0) {
    redirect("/leads/new?error=contentEmpty");
  }

  const kindRaw = String(formData.get("sourceKind") ?? "MANUAL").toUpperCase();
  const sourceKind = (Object.values(SourceKind) as string[]).includes(kindRaw)
    ? (kindRaw as SourceKind)
    : SourceKind.MANUAL;

  const result = await ingestLead({
    content,
    title: String(formData.get("title") ?? "").trim() || null,
    sourceAuthor: String(formData.get("sourceAuthor") ?? "").trim() || null,
    sourceUrl: String(formData.get("sourceUrl") ?? "").trim() || null,
    sourceCreatedAt: parseDate(String(formData.get("sourceCreatedAt") ?? "")),
    sourceKind,
  });

  if (result.outcome === "invalid") {
    redirect(`/leads/new?error=${result.code}`);
  }

  revalidatePath("/dashboard");
  revalidatePath("/leads");

  if (result.outcome === "duplicate") {
    const { code, ...rest } = result.reason;
    const percent = "percent" in rest ? rest.percent : "";
    redirect(`/leads/${result.leadId}?duplicate=${code}&percent=${percent}`);
  }

  redirect(`/leads/${result.leadId}${result.warning ? `?warning=${result.warning}` : ""}`);
}

export async function reanalyzeAction(formData: FormData): Promise<void> {
  await requireOwner();
  const leadId = String(formData.get("leadId") ?? "");

  try {
    await reanalyzeLead(leadId);
  } catch (error) {
    logger.error("re-analysis failed", {
      leadId,
      error: error instanceof Error ? error.message : String(error),
    });
    redirect(`/leads/${leadId}?warning=reanalyzeFailed`);
  }

  revalidateLead(leadId);
  redirect(`/leads/${leadId}`);
}

export async function generateResponseAction(formData: FormData): Promise<void> {
  await requireOwner();
  const leadId = String(formData.get("leadId") ?? "");
  const adjust = String(formData.get("adjust") ?? "").trim() || null;

  try {
    await generateResponseDraft(leadId, adjust);
  } catch (error) {
    const code =
      error instanceof BudgetExceededError
        ? "budgetExceeded"
        : error instanceof OutreachError
          ? error.code
          : "draftFailed";
    logger.error("draft generation failed", {
      leadId,
      code,
      error: error instanceof Error ? error.message : String(error),
    });
    redirect(`/leads/${leadId}?warning=${code}`);
  }

  revalidateLead(leadId);
  redirect(`/leads/${leadId}#draft`);
}

export async function saveDraftAction(formData: FormData): Promise<void> {
  await requireOwner();
  const leadId = String(formData.get("leadId") ?? "");
  const outreachId = String(formData.get("outreachId") ?? "");
  const body = String(formData.get("body") ?? "");

  try {
    await updateDraft(leadId, outreachId, body);
  } catch (error) {
    redirect(
      `/leads/${leadId}?warning=${error instanceof OutreachError ? error.code : "saveFailed"}`,
    );
  }

  revalidateLead(leadId);
  redirect(`/leads/${leadId}#draft`);
}

export async function markContactedAction(formData: FormData): Promise<void> {
  await requireOwner();
  const leadId = String(formData.get("leadId") ?? "");
  const outreachId = String(formData.get("outreachId") ?? "").trim() || undefined;
  const channelRaw = String(formData.get("channel") ?? "").toUpperCase();
  const channel = (Object.values(OutreachChannel) as string[]).includes(channelRaw)
    ? (channelRaw as OutreachChannel)
    : undefined;

  try {
    await markContacted(leadId, { outreachId, channel });
  } catch (error) {
    redirect(`/leads/${leadId}?warning=${error instanceof OutreachError ? error.code : "updateFailed"}`);
  }

  revalidateLead(leadId);
  redirect(`/leads/${leadId}`);
}

export async function changeStatusAction(formData: FormData): Promise<void> {
  await requireOwner();
  const leadId = String(formData.get("leadId") ?? "");
  const statusRaw = String(formData.get("status") ?? "").toUpperCase();

  if (!(Object.values(LeadStatus) as string[]).includes(statusRaw)) {
    redirect(`/leads/${leadId}?warning=unknownStatus`);
  }

  await changeStatus(leadId, statusRaw as LeadStatus);
  revalidateLead(leadId);
  redirect(`/leads/${leadId}`);
}

export async function recordOutcomeAction(formData: FormData): Promise<void> {
  await requireOwner();
  const leadId = String(formData.get("leadId") ?? "");
  const won = String(formData.get("outcome") ?? "") === "won";
  const amountRaw = String(formData.get("amount") ?? "").trim();
  const amount = amountRaw ? Number(amountRaw) : null;

  await recordOutcome(leadId, won, amount !== null && Number.isFinite(amount) ? amount : null);
  revalidateLead(leadId);
  redirect(`/leads/${leadId}`);
}

export async function addNoteAction(formData: FormData): Promise<void> {
  await requireOwner();
  const leadId = String(formData.get("leadId") ?? "");
  const message = String(formData.get("message") ?? "");

  try {
    await addNote(leadId, message);
  } catch {
    redirect(`/leads/${leadId}?warning=noteEmpty`);
  }

  revalidateLead(leadId);
  redirect(`/leads/${leadId}#activity`);
}

export async function completeFollowUpAction(formData: FormData): Promise<void> {
  await requireOwner();
  const leadId = String(formData.get("leadId") ?? "");
  const followUpId = String(formData.get("followUpId") ?? "");

  await completeFollowUp(followUpId);
  revalidateLead(leadId);
  redirect(`/leads/${leadId}`);
}
