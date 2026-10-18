/**
 * The adapters this installation can use.
 *
 * Adapters are built from `.env` and never from the database: credentials are
 * secrets and stay in the environment (README Rule 6). A `Source` row then only
 * carries non-secret settings — which subreddit or channel to watch.
 *
 * An adapter is only registered when it can actually work: Reddit is always
 * present (it can answer the public endpoint, and honestly reports 403 when
 * blocked), while Perplexity is opt-in through its key — a paid API must never
 * be called because a row happened to exist in the database.
 */
import { PerplexityAdapter, type PerplexityRecency } from "@/src/sources/perplexity";
import { RedditAdapter } from "@/src/sources/reddit";
import type { SourceAdapter } from "@/src/sources/types";
import { env, perplexityApiKey } from "@/src/lib/env";

const RECENCY_VALUES: readonly PerplexityRecency[] = ["hour", "day", "week", "month", "year"];

function parseRecency(value: string | undefined): PerplexityRecency | null {
  return RECENCY_VALUES.includes(value as PerplexityRecency)
    ? (value as PerplexityRecency)
    : null;
}

export function buildAdapters(): SourceAdapter[] {
  const config = env();
  const adapters: SourceAdapter[] = [
    new RedditAdapter({
      clientId: config.REDDIT_CLIENT_ID ?? null,
      clientSecret: config.REDDIT_CLIENT_SECRET ?? null,
      userAgent: config.REDDIT_USER_AGENT,
      publicBaseUrl: config.REDDIT_BASE_URL,
      oauthBaseUrl: config.REDDIT_OAUTH_URL,
      timeoutMs: config.REDDIT_TIMEOUT_MS,
    }),
  ];

  const perplexityKey = perplexityApiKey();
  if (perplexityKey) {
    adapters.push(
      new PerplexityAdapter({
        apiKey: perplexityKey,
        baseUrl: config.PERPLEXITY_BASE_URL,
        maxResults: config.PERPLEXITY_MAX_RESULTS,
        recency: parseRecency(config.PERPLEXITY_RECENCY),
        searchType: config.PERPLEXITY_SEARCH_TYPE === "fast" ? "fast" : "web",
        timeoutMs: config.PERPLEXITY_TIMEOUT_MS,
      }),
    );
  }

  return adapters;
}

export function findAdapter(name: string): SourceAdapter | null {
  return buildAdapters().find((adapter) => adapter.name === name) ?? null;
}
