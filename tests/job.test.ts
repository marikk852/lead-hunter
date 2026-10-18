/**
 * The discovery job: single-run lease + run log (Phase 2).
 *
 * Regression coverage for a real bug: the lease comparison used to mix the
 * application clock with Postgres `NOW()`, so a live lease was silently ignored
 * and two scans could overlap. These tests take a real lease in the shared test
 * database and assert the second run is refused.
 *
 * The adapter always throws, so no item is ever ingested: these tests write a run
 * row (and its per-source error rows) and nothing else — no model calls, no leads.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { SourceAdapter } from "@/src/sources/types";

const { runHuntJob } = await import("@/src/sources/job");
const { prisma } = await import("@/src/lib/db");

const createdRunIds: string[] = [];

afterEach(async () => {
  if (createdRunIds.length === 0) return;
  await prisma.scanRun.deleteMany({ where: { id: { in: createdRunIds.splice(0) } } });
  await prisma.jobLock.deleteMany({ where: { id: "hunt" } });
});

afterAll(async () => {
  await prisma.jobLock.deleteMany({ where: { id: "hunt" } });
  await prisma.$disconnect();
});

/** Matches the seeded Reddit queries by adapter name; every call fails. */
function failingAdapter(): SourceAdapter {
  return {
    name: "reddit",
    kind: "REDDIT",
    search: async () => {
      throw new Error("reddit search failed (403): blocked");
    },
  };
}

describe("runHuntJob", () => {
  it("refuses to start while another run holds the lease", async () => {
    await prisma.jobLock.deleteMany({ where: { id: "hunt" } });
    await prisma.jobLock.create({
      data: {
        id: "hunt",
        lockedBy: "other-run",
        lockedUntil: new Date(Date.now() + 10 * 60_000),
      },
    });

    const before = await prisma.scanRun.count();
    const result = await runHuntJob({ adapters: [failingAdapter()], trigger: "manual" });

    expect(result.skipped).toBe("alreadyRunning");
    if (result.skipped !== "alreadyRunning") return;
    expect(result.lockedUntil).toBeInstanceOf(Date);
    expect(await prisma.scanRun.count()).toBe(before);
  });

  it("records a run with per-source error rows and releases the lease", async () => {
    await prisma.jobLock.deleteMany({ where: { id: "hunt" } });

    const result = await runHuntJob({
      adapters: [failingAdapter()],
      trigger: "manual",
      limitPerQuery: 1,
    });

    expect(result.skipped).toBeNull();
    if (result.skipped !== null || !result.runId) return;
    createdRunIds.push(result.runId);

    const run = await prisma.scanRun.findUnique({
      where: { id: result.runId },
      include: { results: true },
    });

    expect(run?.status).toBe("PARTIAL");
    expect(run?.trigger).toBe("manual");
    expect(run?.finishedAt).toBeInstanceOf(Date);
    expect(run?.created).toBe(0);
    expect(run?.results.length).toBeGreaterThan(0);
    expect(run?.results.every((row) => row.status === "ERROR" || row.status === "SKIPPED")).toBe(true);
    expect(run?.results.some((row) => row.status === "ERROR" && row.message?.includes("403"))).toBe(true);

    // The lease is released even though every source failed.
    expect(await prisma.jobLock.count({ where: { id: "hunt" } })).toBe(0);
  });

  it("writes nothing at all in a dry run", async () => {
    const before = await prisma.scanRun.count();
    const result = await runHuntJob({ adapters: [failingAdapter()], dryRun: true });

    expect(result.skipped).toBeNull();
    if (result.skipped !== null) return;
    expect(result.status).toBe("dryRun");
    expect(result.runId).toBeNull();
    expect(await prisma.scanRun.count()).toBe(before);
    expect(await prisma.jobLock.count({ where: { id: "hunt" } })).toBe(0);
  });
});
