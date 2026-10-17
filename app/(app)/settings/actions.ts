"use server";

import path from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { resetAIProviderCache, pingAIKey } from "@/src/ai";
import { requireOwner } from "@/src/auth/session";
import { prisma } from "@/src/lib/db";
import { sanitizeApiKey, setEnvValue } from "@/src/lib/envfile";
import { updateOwnerProfile } from "@/src/profile";

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export async function saveProfileAction(formData: FormData): Promise<void> {
  await requireOwner();

  const minimumBudgetRaw = String(formData.get("minimumBudget") ?? "").trim();
  const minimumBudget = minimumBudgetRaw === "" ? null : Number(minimumBudgetRaw);

  const portfolioRaw = String(formData.get("portfolio") ?? "").trim();
  // One entry per line: "Title | https://url | description"
  const portfolio = portfolioRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [title, url, description] = line.split("|").map((part) => part.trim());
      if (!title && !url) return [];
      return [{ title: title || undefined, url: url || undefined, description: description || undefined }];
    });

  await updateOwnerProfile({
    name: String(formData.get("name") ?? "").trim() || "Developer",
    services: splitList(String(formData.get("services") ?? "")),
    experience: String(formData.get("experience") ?? "").trim() || null,
    location: String(formData.get("location") ?? "").trim() || null,
    languages: splitList(String(formData.get("languages") ?? "")),
    minimumBudget: Number.isFinite(minimumBudget) ? minimumBudget : null,
    tone: String(formData.get("tone") ?? "").trim() || null,
    portfolio,
  });

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  redirect("/settings?saved=profile");
}

export async function addSearchQueryAction(formData: FormData): Promise<void> {
  await requireOwner();

  const query = String(formData.get("query") ?? "").trim();
  // Codes, not prose — the page localizes them (see src/i18n).
  if (query.length === 0) redirect("/settings?error=emptyQuery");

  const kind = String(formData.get("kind") ?? "REDDIT").toUpperCase();
  const adapter = kind.toLowerCase();

  const source = await prisma.source.upsert({
    where: { adapter_name: { adapter, name: `${kind} (queries)` } },
    update: {},
    create: { adapter, name: `${kind} (queries)`, kind: kind as never, config: {} },
  });

  await prisma.searchQuery.create({ data: { query, sourceId: source.id } });

  revalidatePath("/settings");
  redirect("/settings?saved=query");
}

export async function toggleSearchQueryAction(formData: FormData): Promise<void> {
  await requireOwner();

  const id = String(formData.get("queryId") ?? "");
  const existing = await prisma.searchQuery.findUnique({ where: { id } });
  if (!existing) redirect("/settings?error=unknownQuery");

  await prisma.searchQuery.update({ where: { id }, data: { enabled: !existing.enabled } });
  revalidatePath("/settings");
  redirect("/settings");
}

export async function deleteSearchQueryAction(formData: FormData): Promise<void> {
  await requireOwner();

  const id = String(formData.get("queryId") ?? "");
  await prisma.searchQuery.deleteMany({ where: { id } });
  revalidatePath("/settings");
  redirect("/settings");
}

/**
 * Saves the AI keys straight into `.env`, the single source of truth for
 * secrets (README §6). A submitted value is never echoed back — the form
 * re-renders with an empty field and a "saved" placeholder — and `requireOwner()`
 * matters here above all, because this writes credential material.
 */
export async function saveAiKeysAction(formData: FormData): Promise<void> {
  await requireOwner();

  const decide = (
    field: string,
    clearField: string,
    envName: string,
  ): [string, string | null] | null => {
    if (formData.get(clearField) === "on") return [envName, null]; // explicit removal
    const raw = formData.get(field);
    const text = typeof raw === "string" ? raw : "";
    if (text.trim().length === 0) return null; // untouched: keep what is stored
    const cleaned = sanitizeApiKey(text);
    if (!cleaned.ok) redirect("/settings?error=keyInvalid"); // codes, not prose
    return [envName, cleaned.value];
  };

  const updates = [
    decide("aiApiKey", "clearAiApiKey", "AI_API_KEY"),
    decide("anthropicApiKey", "clearAnthropicApiKey", "ANTHROPIC_API_KEY"),
  ].filter((entry): entry is [string, string | null] => entry !== null);

  if (updates.length > 0) {
    const file = path.join(process.cwd(), ".env");
    for (const [envName, value] of updates) {
      await setEnvValue(file, envName, value);
      if (value === null) delete process.env[envName];
      else process.env[envName] = value;
    }
    // The memoized provider still holds the key it was built with.
    resetAIProviderCache();
  }

  revalidatePath("/settings");
  redirect("/settings?saved=keys");
}

/**
 * Runs one live probe of the active AI key and files the result as monitoring
 * history (Settings → key health). Codes travel in the redirect, the vendor's
 * own answer is rendered from the stored row — diagnostics are log-line text,
 * same rule as `lead_events`.
 */
export async function checkAiKeyAction(): Promise<void> {
  await requireOwner();

  const result = await pingAIKey();
  if (!result.configured) redirect("/settings?error=keyProbeNoKey");

  await prisma.aIHealthCheck.create({
    data: {
      provider: result.provider,
      model: result.model,
      ok: result.ok,
      detail: result.detail,
      latencyMs: result.latencyMs,
    },
  });

  // Monitoring history stays bounded: keep the newest 50 probes.
  const stale = await prisma.aIHealthCheck.findMany({
    orderBy: { createdAt: "desc" },
    skip: 50,
    select: { id: true },
  });
  if (stale.length > 0) {
    await prisma.aIHealthCheck.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
  }

  revalidatePath("/settings");
  redirect(result.ok ? "/settings?saved=keyOk" : "/settings?error=keyProbeFailed");
}
