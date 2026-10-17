/**
 * The adapters this installation can use.
 *
 * Adapters are built from `.env` and never from the database: credentials are
 * secrets and stay in the environment (README Rule 6). A `Source` row then only
 * carries non-secret settings — which subreddit or channel to watch.
 */
import { RedditAdapter } from "@/src/sources/reddit";
import type { SourceAdapter } from "@/src/sources/types";
import { env } from "@/src/lib/env";

export function buildAdapters(): SourceAdapter[] {
  const config = env();
  return [
    new RedditAdapter({
      clientId: config.REDDIT_CLIENT_ID ?? null,
      clientSecret: config.REDDIT_CLIENT_SECRET ?? null,
      userAgent: config.REDDIT_USER_AGENT,
      publicBaseUrl: config.REDDIT_BASE_URL,
      oauthBaseUrl: config.REDDIT_OAUTH_URL,
    }),
  ];
}

export function findAdapter(name: string): SourceAdapter | null {
  return buildAdapters().find((adapter) => adapter.name === name) ?? null;
}
