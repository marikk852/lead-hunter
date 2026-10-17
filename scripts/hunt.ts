#!/usr/bin/env node
/**
 * One scan of every enabled saved query (Phase 2, README §5/§28).
 *
 *   npm run hunt                  # scan, ingest, analyse, score
 *   npm run hunt -- --dry-run     # show what would be found, write nothing
 *   npm run hunt -- --limit 10    # fewer items per query
 *   npm run hunt -- --health      # only check that each adapter can talk out
 *
 * Every lead goes through the same pipeline as a manually pasted post, so the
 * dashboard, dedupe and score behave identically. Nothing is ever sent.
 */
import "./load-env";
import { buildAdapters } from "@/src/sources/registry";
import { DEFAULT_LIMIT_PER_QUERY, runHunt } from "@/src/sources/run";

function flagValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : null;
}

async function health(): Promise<number> {
  const adapters = buildAdapters();
  let ok = true;

  for (const adapter of adapters) {
    if (!adapter.healthCheck) {
      console.log(`${adapter.name}: no health check`);
      continue;
    }
    const result = await adapter.healthCheck();
    ok &&= result.ok;
    console.log(`${adapter.name}: ${result.ok ? "OK" : "FAIL"} — ${result.detail}`);
  }

  return ok ? 0 : 1;
}

async function main(): Promise<number> {
  if (process.argv.includes("--health")) return health();

  const dryRun = process.argv.includes("--dry-run");
  const limit = Number(flagValue("--limit") ?? DEFAULT_LIMIT_PER_QUERY);
  const adapters = buildAdapters();

  console.log(
    `hunting with ${adapters.map((adapter) => adapter.name).join(", ")}${
      dryRun ? " (dry run — nothing is written)" : ""
    }`,
  );

  const started = Date.now();
  const summary = await runHunt({
    adapters,
    limitPerQuery: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT_PER_QUERY,
    dryRun,
    onItem: (adapter, query, item) =>
      console.log(`  [${adapter}] "${query}" -> ${item.title ?? item.content.slice(0, 60)}`),
  });

  console.log("\nsummary");
  console.log("  queries run ", summary.queriesRun);
  console.log("  discovered  ", summary.discovered);
  console.log("  created     ", summary.created);
  console.log("  duplicates  ", summary.duplicates);
  console.log("  invalid     ", summary.invalid);
  console.log("  failed      ", summary.failed);
  console.log("  took        ", `${Date.now() - started} ms`);

  for (const lead of summary.leads) {
    console.log(`  -> ${lead.score}/100 ${lead.temperature}  ${lead.title}`);
  }
  for (const error of summary.errors) {
    console.log(`  ! [${error.adapter}] ${error.query}: ${error.message}`);
  }

  if (summary.stopped === "budgetExceeded") {
    console.log("\nStopped at AI_DAILY_CALL_LIMIT. Raise it, or wait for tomorrow.");
    return 2;
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("\nhunt failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
