/**
 * Idempotent seed: the owner profile, a manual source and starter queries.
 * Run with `npm run db:seed` (wired up in prisma7.config.ts).
 *
 * Relative, extensionless imports on purpose — this script runs via tsx,
 * outside the Next bundler.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { DEFAULT_PROFILE } from "../src/profile-defaults";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const STARTER_QUERIES: Array<{ query: string; kind: "REDDIT" | "TELEGRAM" | "WEB" }> = [
  { query: "looking for a web developer", kind: "REDDIT" },
  { query: "need a website for my business", kind: "REDDIT" },
  { query: "need a wordpress developer", kind: "REDDIT" },
  { query: "need a woocommerce developer", kind: "REDDIT" },
  { query: "need someone to build an app", kind: "REDDIT" },
  { query: "need a shopify developer", kind: "REDDIT" },
  { query: "website developer needed", kind: "WEB" },
  { query: "ищу разработчика сайта", kind: "TELEGRAM" },
];

async function main() {
  const profile = await prisma.developerProfile.upsert({
    where: { id: "owner" },
    update: {},
    create: { id: "owner", ...DEFAULT_PROFILE },
  });

  await prisma.source.upsert({
    where: { adapter_name: { adapter: "manual", name: "Manual entry" } },
    update: {},
    create: { adapter: "manual", name: "Manual entry", kind: "MANUAL", config: {} },
  });

  let created = 0;
  for (const entry of STARTER_QUERIES) {
    const source = await prisma.source.upsert({
      where: {
        adapter_name: { adapter: entry.kind.toLowerCase(), name: `${entry.kind} (queries)` },
      },
      update: {},
      create: {
        adapter: entry.kind.toLowerCase(),
        name: `${entry.kind} (queries)`,
        kind: entry.kind,
        config: {},
      },
    });

    const existing = await prisma.searchQuery.findFirst({
      where: { query: entry.query, sourceId: source.id },
    });
    if (!existing) {
      await prisma.searchQuery.create({ data: { query: entry.query, sourceId: source.id } });
      created += 1;
    }
  }

  console.log("seed complete", {
    profile: profile.name,
    queriesCreated: created,
    sources: await prisma.source.count(),
    queries: await prisma.searchQuery.count(),
    leads: await prisma.lead.count(),
  });
}

main()
  .catch((error) => {
    console.error("seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
