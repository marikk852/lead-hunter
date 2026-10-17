/**
 * Prisma client singleton (Prisma 7 → driver adapter required).
 * The adapter also owns the connection pool, so it is created once per process.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/src/generated/prisma/client";
import { env } from "@/src/lib/env";

function createClient() {
  const adapter = new PrismaPg({
    connectionString: env().DATABASE_URL,
    // Prisma 6 waited 5s for a connection; node-postgres waits forever by default.
    connectionTimeoutMillis: 5_000,
  });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { leadHunterPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.leadHunterPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.leadHunterPrisma = prisma;
