"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/src/auth/session";
import { prisma } from "@/src/lib/db";
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
