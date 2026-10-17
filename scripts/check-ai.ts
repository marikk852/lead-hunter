#!/usr/bin/env node
/**
 * One real AI call, so a freshly pasted key can be verified in seconds.
 *
 *   npm run ai:check                 # the strong prompt on the spec's example post
 *   npm run ai:check -- --plain "..."  # any text of your own
 *   npm run ai:check -- --screen       # the cheap screening tier instead
 *   npm run ai:check -- --draft        # the reply-drafting path instead
 *
 * Prints the resolved provider, model, the score the rules would have to agree
 * with, token usage and any run notes. Exits non-zero on any failure, so it can
 * be used as a smoke test in CI once a key is available.
 */
// Must come first: it loads `.env` before any module reads process.env at
// module scope (the Prisma client does).
import "../scripts/load-env";
import { describeAIProvider, getAIProvider, heuristicAnalyze } from "@/src/ai";
import { scoreLead } from "@/src/leads/scoring";
import { getOwnerProfile } from "@/src/profile";

const EXAMPLE_POST = `Need a WooCommerce store for our construction company. Budget around €2,000, want it live this month. We have about 40 products and need a quote request form.`;

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : null;
}

async function main(): Promise<number> {
  const info = describeAIProvider();
  const onlyScreen = process.argv.includes("--screen");
  const onlyDraft = process.argv.includes("--draft");
  const content = argValue("--plain") ?? EXAMPLE_POST;

  console.log("provider:", info.name);
  // Report the model that will actually be called for this run.
  console.log("model:   ", onlyScreen ? `${info.fastModel} (screen tier)` : info.model);
  console.log("chosen:  ", info.reason, info.expectedKey ? `(missing ${info.expectedKey})` : "");

  if (!info.keyed) {
    console.log(
      "\nNo API key is configured, so this run would use the rules. Put a free key in",
      "\nAI_API_KEY (.env), then run this again to exercise the real model path.",
    );
    return 1;
  }

  const provider = getAIProvider();
  const lead = {
    content,
    sourceKind: "REDDIT" as const,
    sourceAuthor: "u/example",
    sourceCreatedAt: new Date(),
    sourceUrl: "https://example.com/post/1",
  };

  const started = Date.now();

  // The drafting path is a third, separate code path — prose, no schema — so it
  // needs its own live check rather than being assumed from the analysis one.
  if (onlyDraft) {
    const profile = await getOwnerProfile();
    const analysis = heuristicAnalyze({ content, sourceKind: "REDDIT" });
    const outcome = await provider.generateResponse({ lead, analysis, profile, adjust: null });

    console.log(`\ndraft (${Date.now() - started} ms):`);
    console.log(outcome.body);
    console.log("\nusage: ", outcome.usage ?? "not reported");
    for (const note of outcome.notes) console.log("note:  ", note);
    return outcome.body.trim().length > 0 ? 0 : 1;
  }

  if (onlyScreen) {
    if (!provider.screen) {
      console.error("this provider has no screening tier");
      return 1;
    }
    const outcome = await provider.screen(lead);
    console.log("\nscreen:", outcome.screen, `(${Date.now() - started} ms)`);
    console.log("usage: ", outcome.usage);
    for (const note of outcome.notes) console.log("note:  ", note);
    return outcome.screen.isCandidate ? 0 : 2;
  }

  const outcome = await provider.analyzeLead(lead);

  // The score needs the owner profile from Postgres. If the database is not
  // reachable, still report the analysis rather than failing the whole check.
  let scoreSection: string | null = null;
  let heuristicLine: string | null = null;
  try {
    const profile = await getOwnerProfile();
    const context = {
      sourceAuthor: lead.sourceAuthor,
      sourceUrl: lead.sourceUrl,
      sourceCreatedAt: lead.sourceCreatedAt,
    };
    const score = scoreLead(outcome.analysis, context, profile);
    scoreSection = `  score        ${score.total}/100 ${score.temperature}`;

    const { heuristicAnalyze } = await import("@/src/ai");
    const heuristic = heuristicAnalyze(lead);
    const heuristicScore = scoreLead(heuristic, context, profile);
    heuristicLine = `  isLead ${heuristic.isLead} · intent ${heuristic.intentScore} · score ${heuristicScore.total}/100 ${heuristicScore.temperature}`;
  } catch (error) {
    console.log("\n(note: could not score — database unreachable:", error instanceof Error ? error.message : error, ")");
  }

  console.log(`\nanalysis (${Date.now() - started} ms):`);
  console.log("  isLead      ", outcome.analysis.isLead, `(confidence ${outcome.analysis.confidence})`);
  console.log("  category    ", outcome.analysis.category);
  console.log("  intentScore ", outcome.analysis.intentScore, "/100");
  console.log("  budget      ", outcome.analysis.budget);
  console.log("  urgency     ", outcome.analysis.urgency);
  if (scoreSection) console.log(scoreSection);
  console.log("  reasoning   ", outcome.analysis.reasoning);
  console.log("usage: ", outcome.usage ?? "not reported");
  for (const note of outcome.notes) console.log("note:  ", note);

  if (heuristicLine) {
    console.log("\nWhat the rules say about the same post (for comparison):");
    console.log(heuristicLine);
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("\nAI check failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
