/**
 * One discovery job = acquire lock → open a ScanRun → runHunt → record results.
 *
 * Why this exists instead of calling `runHunt` directly:
 *  - **Overlap protection.** A cron tick and a manual `npm run hunt` must not
 *    scan the same sources twice. The lock is a single database row taken with
 *    one atomic `INSERT … ON CONFLICT DO UPDATE … WHERE` statement, so it needs
 *    no Redis and survives a crashed process (the lease expires).
 *  - **Run log.** Every run and every per-source result is persisted, which is
 *    what makes "the source was checked and found nothing" distinguishable from
 *    "the source failed" after the terminal is gone.
 *  - **Recovery.** The lease expires, so a killed process cannot block all future
 *    scans; the next tick simply takes the lock.
 *
 * The job is one-shot by design: cron/launchd call it on a schedule. There is no
 * daemon to keep alive and no in-process timer, which matches the architecture
 * (a long scan must not live inside an HTTP request).
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/src/lib/db";
import { logger } from "@/src/lib/logger";
import { runHunt, type HuntSummary } from "@/src/sources/run";
import type { SourceAdapter } from "@/src/sources/types";
import type { ScanRunStatus } from "@/src/generated/prisma/enums";

export const HUNT_LOCK_ID = "hunt";

export type HuntTrigger = "manual" | "cron" | "cli";

export type HuntJobOptions = {
  adapters: SourceAdapter[];
  trigger?: HuntTrigger;
  dryRun?: boolean;
  limitPerQuery?: number;
  now?: Date;
  onItem?: (adapter: string, query: string, item: unknown) => void;
};

export type HuntJobResult =
  | {
      skipped: "alreadyRunning";
      /** When the current lease expires, so the caller can explain the wait. */
      lockedUntil: Date | null;
    }
  | {
      skipped: null;
      runId: string | null;
      status: ScanRunStatus | "dryRun";
      summary: HuntSummary;
    };

/** Milliseconds a run may hold the lock before another run may take it. */
function leaseMs(): number {
  const minutes = Number(process.env.HUNT_LOCK_MINUTES ?? "60");
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
}

async function acquireLock(owner: string, until: Date): Promise<boolean> {
  // The timestamp comes from the *application* on both sides of the comparison:
  // mixing a JS `Date` with the server's `NOW()` compares a naive column against
  // the database's local clock, which silently ignored a live lease here. One
  // clock, one comparison.
  const now = new Date();
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO job_locks (id, locked_by, locked_until, updated_at)
    VALUES (${HUNT_LOCK_ID}, ${owner}, ${until}, ${now})
    ON CONFLICT (id) DO UPDATE
      SET locked_by = EXCLUDED.locked_by,
          locked_until = EXCLUDED.locked_until,
          updated_at = EXCLUDED.updated_at
      WHERE job_locks.locked_until < ${now}
    RETURNING id
  `;
  return rows.length > 0;
}

async function lockHolder(): Promise<Date | null> {
  const rows = await prisma.jobLock.findUnique({ where: { id: HUNT_LOCK_ID } });
  return rows?.lockedUntil ?? null;
}

async function releaseLock(owner: string): Promise<void> {
  await prisma.jobLock.deleteMany({ where: { id: HUNT_LOCK_ID, lockedBy: owner } });
}

function statusFor(summary: HuntSummary): ScanRunStatus {
  if (summary.stopped === "budgetExceeded") return "PARTIAL";
  if (summary.errors.length > 0 || summary.failed > 0) return "PARTIAL";
  return "SUCCEEDED";
}

/**
 * Runs one discovery job. A dry run deliberately writes no run row and takes no
 * lock: it changes nothing, so it must not be able to block a real scan.
 */
export async function runHuntJob(options: HuntJobOptions): Promise<HuntJobResult> {
  const dryRun = Boolean(options.dryRun);
  const trigger = options.trigger ?? "manual";
  const now = options.now ?? new Date();

  if (dryRun) {
    const summary = await runHunt({
      adapters: options.adapters,
      limitPerQuery: options.limitPerQuery,
      now,
      dryRun: true,
      onItem: options.onItem,
    });
    return { skipped: null, runId: null, status: "dryRun", summary };
  }

  const owner = `${trigger}:${randomUUID()}`;
  const acquired = await acquireLock(owner, new Date(Date.now() + leaseMs()));
  if (!acquired) {
    const lockedUntil = await lockHolder();
    logger.warn("hunt skipped: another run holds the lock", {
      lockedUntil: lockedUntil?.toISOString() ?? null,
    });
    return { skipped: "alreadyRunning", lockedUntil };
  }

  const run = await prisma.scanRun.create({
    data: { trigger, dryRun: false },
  });

  try {
    const summary = await runHunt({
      adapters: options.adapters,
      limitPerQuery: options.limitPerQuery,
      now,
      onItem: options.onItem,
    });

    const status = statusFor(summary);

    // A query could have been deleted while the scan was running; the run log
    // must not fail on that foreign key, so keep only ids that still exist.
    const queryIds = [...new Set(summary.sourceResults.flatMap((r) => (r.queryId ? [r.queryId] : [])))];
    const existingQueries = new Set(
      queryIds.length === 0
        ? []
        : (
            await prisma.searchQuery.findMany({
              where: { id: { in: queryIds } },
              select: { id: true },
            })
          ).map((row) => row.id),
    );

    await prisma.$transaction([
      ...summary.sourceResults.map((result) =>
        prisma.scanSourceResult.create({
          data: {
            runId: run.id,
            adapter: result.adapter,
            queryId: result.queryId && existingQueries.has(result.queryId) ? result.queryId : null,
            query: result.query,
            status: result.status,
            items: result.items,
            message: result.message ?? null,
            durationMs: result.durationMs,
          },
        }),
      ),
      prisma.scanRun.update({
        where: { id: run.id },
        data: {
          status,
          finishedAt: new Date(),
          queriesRun: summary.queriesRun,
          discovered: summary.discovered,
          created: summary.created,
          duplicates: summary.duplicates,
          invalid: summary.invalid,
          failed: summary.failed,
          stopped: summary.stopped,
          summary: {
            leads: summary.leads,
            errors: summary.errors,
            sourceResults: summary.sourceResults,
          } as unknown as object,
        },
      }),
    ]);

    logger.info("hunt finished", {
      runId: run.id,
      status,
      queriesRun: summary.queriesRun,
      discovered: summary.discovered,
      created: summary.created,
      duplicates: summary.duplicates,
      failed: summary.failed,
    });

    return { skipped: null, runId: run.id, status, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.scanRun
      .update({
        where: { id: run.id },
        data: { status: "FAILED", finishedAt: new Date(), error: message.slice(0, 2000) },
      })
      .catch(() => undefined);
    logger.error("hunt failed", { runId: run.id, error: message });
    throw error;
  } finally {
    await releaseLock(owner).catch((error: unknown) => {
      // A stale lock is recoverable (the lease expires); failing the whole run
      // because cleanup failed is not useful.
      logger.warn("could not release hunt lock", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/** Newest runs with their per-source rows, for the console. */
export async function recentScanRuns(take = 5) {
  return prisma.scanRun.findMany({
    orderBy: { startedAt: "desc" },
    take,
    include: { results: { orderBy: { createdAt: "asc" } } },
  });
}

