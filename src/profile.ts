/**
 * The single owner profile (README §16). Every fact the AI may use when
 * drafting a reply has to come from here — it must never invent experience.
 */
import type { OwnerProfileFacts } from "@/src/ai/schemas";
import { prisma } from "@/src/lib/db";
import { DEFAULT_PROFILE, type PortfolioEntry } from "@/src/profile-defaults";

export { DEFAULT_PROFILE };

function parsePortfolio(value: unknown): PortfolioEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const item = entry as Record<string, unknown>;
    return [
      {
        title: typeof item.title === "string" ? item.title : undefined,
        url: typeof item.url === "string" ? item.url : undefined,
        description: typeof item.description === "string" ? item.description : undefined,
      },
    ];
  });
}

/** Reads the profile, creating the seeded default on first use. */
export async function getOwnerProfile(): Promise<OwnerProfileFacts> {
  const record = await prisma.developerProfile.upsert({
    where: { id: "owner" },
    update: {},
    create: { id: "owner", ...DEFAULT_PROFILE },
  });

  return {
    name: record.name,
    services: record.services,
    experience: record.experience,
    location: record.location,
    languages: record.languages,
    minimumBudget: record.minimumBudget,
    portfolio: parsePortfolio(record.portfolio),
    tone: record.tone,
  };
}

export async function updateOwnerProfile(input: {
  name?: string;
  services?: string[];
  experience?: string | null;
  location?: string | null;
  languages?: string[];
  minimumBudget?: number | null;
  tone?: string | null;
  portfolio?: PortfolioEntry[];
}) {
  await getOwnerProfile(); // ensure the row exists before updating
  return prisma.developerProfile.update({
    where: { id: "owner" },
    data: input,
  });
}

/** True when the profile still holds the seed values — used to nudge the owner. */
export function isProfileUnconfigured(profile: OwnerProfileFacts): boolean {
  return profile.name === DEFAULT_PROFILE.name && profile.portfolio.length === 0;
}
