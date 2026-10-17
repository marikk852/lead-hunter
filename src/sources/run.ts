/**
 * The hunt: run every enabled saved query through the source adapters and feed
 * the results to the existing per-item pipeline.
 *
 * Nothing new happens to a lead here — discovery is the only addition. The
 * pipeline still dedupes, analyses, scores and files each item, so a source
 * adapter cannot invent a lead that the manual path would have rejected.
 *
 * Everything is injectable (`store`, `ingest`) and there is no timer inside: the
 * same function is called by `npm run hunt` today and by the Phase 2 worker/cron
 * later, which is why it takes `now` instead of reading the clock.
 */
import { BudgetExceededError } from "@/src/ai";
import { SourceKind } from "@/src/generated/prisma/enums";
import { ingestLead, type IngestResult } from "@/src/leads/pipeline";
import { prisma } from "@/src/lib/db";
import { logger } from "@/src/lib/logger";
import type { SourceAdapter, SourceItem } from "@/src/sources/types";

/** The slice of the database this runner needs, so tests can inject a fake. */
export type HuntStore = {
  enabledQueries(): Promise<Array<{ id: string; query: string; sourceId: string | null }>>;
  sources(ids: string[]): Promise<Array<{ id: string; adapter: string; kind: SourceKind; enabled: boolean }>>;
  markQueryRun(queryId: string, at: Date): Promise<void>;
  markSourceScan(sourceId: string, at: Date): Promise<void>;
};

export const prismaHuntStore: HuntStore = {
  async enabledQueries() {
    return prisma.searchQuery.findMany({
      where: { enabled: true },
      select: { id: true, query: true, sourceId: true },
      orderBy: { createdAt: "asc" },
    });
  },

  async sources(ids) {
    if (ids.length === 0) return [];
    const rows = await prisma.source.findMany({
      where: { id: { in: ids } },
      select: { id: true, adapter: true, kind: true, enabled: true },
    });
    return rows;
  },

  async markQueryRun(queryId, at) {
    await prisma.searchQuery.update({ where: { id: queryId }, data: { lastRunAt: at } });
  },

  async markSourceScan(sourceId, at) {
    await prisma.source.update({ where: { id: sourceId }, data: { lastScanAt: at } });
  },
};

export type HuntOptions = {
  adapters: SourceAdapter[];
  /** Items requested per query, per adapter. */
  limitPerQuery?: number;
  now?: Date;
  ingest?: typeof ingestLead;
  store?: HuntStore;
  /** Discover and report, but write nothing. */
  dryRun?: boolean;
  /** Called for every item, for progress output. */
  onItem?: (adapter: string, query: string, item: SourceItem) => void;
};

export type HuntSummary = {
  ranAt: Date;
  dryRun: boolean;
  queriesRun: number;
  discovered: number;
  created: number;
  duplicates: number;
  invalid: number;
  failed: number;
  /** Set when the run stopped early instead of finishing every query. */
  stopped: "budgetExceeded" | null;
  leads: Array<{ leadId: string; score: number; temperature: string; title: string }>;
  errors: Array<{ adapter: string; query: string; message: string }>;
};

export const DEFAULT_LIMIT_PER_QUERY = 25;

function matchAdapters(
  query: { sourceId: string | null },
  adapters: SourceAdapter[],
  sources: Map<string, { adapter: string; kind: SourceKind; enabled: boolean }>,
): SourceAdapter[] {
  if (!query.sourceId) return adapters;

  const source = sources.get(query.sourceId);
  if (!source || !source.enabled) return [];
  return adapters.filter((adapter) => adapter.name === source.adapter);
}

function tally(summary: HuntSummary, result: IngestResult, title: string) {
  switch (result.outcome) {
    case "created":
      summary.created += 1;
      summary.leads.push({
        leadId: result.leadId,
        score: result.score,
        temperature: result.temperature,
        title,
      });
      break;
    case "duplicate":
      summary.duplicates += 1;
      break;
    case "invalid":
      summary.invalid += 1;
      break;
  }
}

/**
 * Runs one scan. Never throws for a single broken query or item: failures are
 * collected in the summary, because one unreachable source must not lose the
 * leads another source already found (README Rule: partial failure is normal).
 */
export async function runHunt(options: HuntOptions): Promise<HuntSummary> {
  const store = options.store ?? prismaHuntStore;
  const ingest = options.ingest ?? ingestLead;
  const now = options.now ?? new Date();
  const limit = options.limitPerQuery ?? DEFAULT_LIMIT_PER_QUERY;

  const summary: HuntSummary = {
    ranAt: now,
    dryRun: Boolean(options.dryRun),
    queriesRun: 0,
    discovered: 0,
    created: 0,
    duplicates: 0,
    invalid: 0,
    failed: 0,
    stopped: null,
    leads: [],
    errors: [],
  };

  const queries = await store.enabledQueries();
  const sources = new Map(
    (await store.sources(queries.map((query) => query.sourceId).filter((id): id is string => Boolean(id)))).map(
      (source) => [source.id, source],
    ),
  );

  for (const query of queries) {
    if (summary.stopped) break;

    const adapters = matchAdapters(query, options.adapters, sources);
    summary.queriesRun += 1;

    for (const adapter of adapters) {
      if (summary.stopped) break;

      let items: SourceItem[];
      try {
        items = await adapter.search({ query: query.query, limit });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("source search failed", { adapter: adapter.name, query: query.query, message });
        summary.errors.push({ adapter: adapter.name, query: query.query, message });
        continue;
      }

      summary.discovered += items.length;

      for (const item of items) {
        options.onItem?.(adapter.name, query.query, item);
        if (summary.dryRun) continue;

        try {
          const result = await ingest({
            content: item.content,
            title: item.title,
            sourceAuthor: item.author,
            sourceUrl: item.url,
            sourceExternalId: item.externalId,
            sourceCreatedAt: item.createdAt,
            sourceKind: adapter.kind,
            sourceName: adapter.name,
          });
          tally(summary, result, item.title ?? item.content.slice(0, 80));
        } catch (error) {
          if (error instanceof BudgetExceededError) {
            // Stop the whole run: every further item would fail the same way.
            logger.warn("hunt stopped at the daily AI call limit", { limit: error.limit });
            summary.stopped = "budgetExceeded";
            break;
          }
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("source item failed", { adapter: adapter.name, message });
          summary.failed += 1;
          summary.errors.push({ adapter: adapter.name, query: query.query, message });
        }
      }
    }

    if (!summary.dryRun) await store.markQueryRun(query.id, now);
    if (query.sourceId) await store.markSourceScan(query.sourceId, now);
  }

  return summary;
}
