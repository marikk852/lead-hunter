/**
 * Ingestion idempotency (§6 / Definition of Done #6): running the same discovery
 * twice must never create two records or crash.
 *
 * Sequential duplicates are caught by the dedupe pre-check. The harder case is
 * an insert race: a lead whose row becomes visible *after* the pre-check (or was
 * sitting outside the candidate window) makes `prisma.lead.create` throw a
 * unique-constraint violation — that path has to attach to the existing record.
 *
 * These are integration tests: they need `DATABASE_URL` like the other DB suites.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";

/**
 * Deterministic by rule (§16): the default suite must never depend on paid
 * external APIs. `src/lib/db.ts` calls `env().DATABASE_URL` *at import time*,
 * which freezes `AI_PROVIDER` into the env cache — so the flag has to be set
 * before the app graph loads, and the app is imported dynamically right after.
 * Works with or without a `.env.test` file and even when the developer's
 * `.env` carries a live key.
 */
const ORIGINAL_PROVIDER = process.env.AI_PROVIDER;
process.env.AI_PROVIDER = "heuristic";

const { SourceKind } = await import("@/src/generated/prisma/enums");
const { ingestLead } = await import("@/src/leads/pipeline");
const { prisma } = await import("@/src/lib/db");

afterAll(() => {
  if (ORIGINAL_PROVIDER === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = ORIGINAL_PROVIDER;
});

/** Probe rows are named by prefix so cleanup survives a mid-test timeout. */
const PROBE_PREFIXES = ["t3-idem-", "t3-race-"];

afterEach(async () => {
  // lead_events cascade with the lead; shared Source rows are reused.
  await prisma.lead.deleteMany({
    where: { sourceExternalId: { startsWith: PROBE_PREFIXES[0] } },
  });
  await prisma.lead.deleteMany({
    where: { sourceExternalId: { startsWith: PROBE_PREFIXES[1] } },
  });
});

describe("ingestion idempotency", () => {
  it("returns the existing lead when the same external item arrives again", async () => {
    const externalId = `t3-idem-${Date.now()}`;
    const content = `Idempotency probe ${Date.now()} — need a woocommerce developer asap.`;

    const first = await ingestLead({
      content,
      sourceKind: SourceKind.REDDIT,
      sourceName: "Idempotency test",
      sourceExternalId: externalId,
    });
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") return;

    const second = await ingestLead({
      // Same post, same id — even a reworded body must not fork the record.
      content: `${content} (reworded)`,
      sourceKind: SourceKind.REDDIT,
      sourceName: "Idempotency test",
      sourceExternalId: externalId,
    });

    expect(second.outcome).toBe("duplicate");
    if (second.outcome !== "duplicate") return;
    expect(second.leadId).toBe(first.leadId);
    expect(second.reason.code).toBe("sameSourceItem");
    expect(second.similarity).toBe(1);
  });

  it("survives the insert race: a row invisible to the pre-check still attaches", async () => {
    const externalId = `t3-race-${Date.now()}`;
    const source = await prisma.source.upsert({
      where: { adapter_name: { adapter: "reddit", name: "Race test" } },
      update: {},
      create: { adapter: "reddit", name: "Race test", kind: SourceKind.REDDIT, config: {} },
    });

    // Outside the 120-day candidate window and with a different content hash, so
    // findDedupeCandidates cannot see it — only the database constraint can.
    const winner = await prisma.lead.create({
      data: {
        sourceId: source.id,
        sourceExternalId: externalId,
        originalContent: "ancient post from outside the candidate window",
        contentHash: `race-${externalId}`,
        createdAt: new Date(Date.now() - 180 * 86_400_000),
      },
    });

    const result = await ingestLead({
      content: `Fresh wording that hash-matches nothing ${externalId}`,
      sourceId: source.id,
      sourceExternalId: externalId,
    });

    // Without the P2002 recovery this threw PrismaClientKnownRequestError.
    expect(result.outcome).toBe("duplicate");
    if (result.outcome !== "duplicate") return;
    expect(result.leadId).toBe(winner.id);
    expect(result.reason.code).toBe("sameSourceItem");

    const events = await prisma.leadEvent.count({
      where: { leadId: winner.id, type: "DEDUPLICATED" },
    });
    expect(events).toBeGreaterThanOrEqual(1);
  });
});