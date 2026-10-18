#!/usr/bin/env node
/**
 * One scan of every enabled saved query (Phase 2, README §5/§28).
 *
 *   npm run hunt                  # scan, ingest, analyse, score
 *   npm run hunt -- --dry-run     # show what would be found, write nothing
 *   npm run hunt -- --limit 10    # fewer items per query
 *   npm run hunt -- --health      # only check that each adapter can talk out
 *
 * This is the same command cron/launchd call; it is one-shot on purpose.
 * Concurrent runs are prevented by a database lease, and every real run is
 * recorded in `scan_runs` / `scan_source_results`. Nothing is ever sent.
 */
import "./load-env";
import { buildAdapters } from "@/src/sources/registry";
import { DEFAULT_LIMIT_PER_QUERY } from "@/src/sources/run";
import { runHuntJob, type HuntTrigger } from "@/src/sources/job";

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
    console.log(
      `${adapter.name}: ${result.ok ? "OK" : "FAIL"}${
        result.code ? ` [${result.code}]` : ""
      } — ${result.detail}`,
    );
  }

  if (adapters.length === 0) {
    console.log("no adapters configured");
    return 1;
  }

  return ok ? 0 : 1;
}

function triggerFromArgs(): HuntTrigger {
  if (process.argv.includes("--scheduled") || process.env.HUNT_TRIGGER === "cron") return "cron";
  return "cli";
}

async function main(): Promise<number> {
  if (process.argv.includes("--health")) return health();

  const dryRun = process.argv.includes("--dry-run");
  const limit = Number(flagValue("--limit") ?? DEFAULT_LIMIT_PER_QUERY);
  const adapters = buildAdapters();

  console.log(
    `hunting with ${adapters.map((adapter) => adapter.name).join(", ") || "no adapters"}${
      dryRun ? " (dry run — nothing is written)" : ""
    }`,
  );

  const started = Date.now();
  const result = await runHuntJob({
    adapters,
    trigger: triggerFromArgs(),
    dryRun,
    limitPerQuery: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT_PER_QUERY,
    onItem: (adapter, query, item) => {
      const typed = item as { title?: string | null; content?: string };
      console.log(
        `  [${adapter}] "${query}" -> ${typed.title ?? (typed.content ?? "").slice(0, 60)}`,
      );
    },
  });

  if (result.skipped === "alreadyRunning") {
    console.log(
      `another scan is already running (lock until ${result.lockedUntil?.toISOString() ?? "unknown"}); nothing to do`,
    );
    return 0;
  }

  const { summary } = result;

  console.log("\nsources");
  if (summary.sourceResults.length === 0) {
    console.log("  (no queries matched an adapter)");
  }
  // Diagnostic text is kept verbatim in the database; the terminal just needs
  // enough of it to tell a rate limit from an HTML error page.
  const brief = (text: string | undefined) =>
    text === undefined ? "" : text.length > 120 ? `${text.slice(0, 120)}…` : text;

  for (const source of summary.sourceResults) {
    const label =
      source.status === "OK"
        ? `${source.items} item(s)`
        : source.status === "EMPTY"
          ? "checked, no items"
          : brief(source.message) || source.status.toLowerCase();
    console.log(
      `  ${source.status.padEnd(7)} ${source.adapter} "${source.query}" — ${label} (${source.durationMs} ms)`,
    );
  }

  console.log("\nsummary");
  console.log("  run         ", result.runId ?? "(dry run)");
  console.log("  status      ", result.status);
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
    console.log(
      `  ! [${error.adapter}] ${error.query}${error.code ? ` (${error.code})` : ""}: ${brief(error.message)}`,
    );
  }

  if (summary.stopped === "budgetExceeded") {
    console.log("\nStopped at AI_DAILY_CALL_LIMIT. Raise it, or wait for tomorrow.");
    return 2;
  }

  // A total source outage is a failure exit code, so cron alerts on it. Partial
  // failure still exits 0: some sources working is a successful run.
  const allSourcesFailed =
    summary.sourceResults.length > 0 && summary.sourceResults.every((row) => row.status === "ERROR");
  return allSourcesFailed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("\nhunt failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
