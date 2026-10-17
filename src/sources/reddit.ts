/**
 * Reddit adapter (Phase 2, README §5).
 *
 * Read-only, and deliberately credential-tolerant:
 *  - with `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` it uses the documented
 *    OAuth2 client-credentials flow against `oauth.reddit.com`;
 *  - without them it falls back to the public JSON search endpoint, which is
 *    rate-limited but enough to find a handful of posts by hand.
 *
 * No vendor SDK: plain `fetch` behind an injectable seam, so the request shape is
 * testable offline. Nothing is posted, voted on or messaged — this only reads.
 */
import type { SourceKind } from "@/src/generated/prisma/enums";
import { logger } from "@/src/lib/logger";
import type { AdapterHealth, AdapterQuery, SourceAdapter, SourceItem } from "@/src/sources/types";

export const REDDIT_ADAPTER_NAME = "reddit";

/** The API rejects requests without a descriptive, unique User-Agent. */
export const DEFAULT_USER_AGENT = "lead-hunter/0.1 (personal use)";

export type RedditFetch = (
  url: string,
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type RedditAdapterConfig = {
  clientId?: string | null;
  clientSecret?: string | null;
  userAgent?: string;
  /** OAuth host for authenticated calls. */
  oauthBaseUrl?: string;
  /** Public host used when no credentials are configured. */
  publicBaseUrl?: string;
  fetch?: RedditFetch;
  /** Test seam for token caching. */
  now?: () => number;
};

/** A single `data.children[].data` entry, only the fields we consume. */
type RedditChild = {
  kind?: string;
  data?: {
    id?: string;
    name?: string;
    title?: string;
    selftext?: string;
    author?: string;
    permalink?: string;
    url?: string;
    created_utc?: number;
    stickied?: boolean;
    over_18?: boolean;
    subreddit?: string;
  };
};

type RedditListing = {
  data?: { children?: RedditChild[] };
  error?: number | string;
  message?: string;
};

export class RedditAdapter implements SourceAdapter {
  readonly name = REDDIT_ADAPTER_NAME;
  readonly kind: SourceKind = "REDDIT";

  private readonly userAgent: string;
  private readonly oauthBaseUrl: string;
  private readonly publicBaseUrl: string;
  private readonly doFetch: RedditFetch;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: RedditAdapterConfig = {}) {
    this.userAgent = config.userAgent?.trim() || DEFAULT_USER_AGENT;
    this.oauthBaseUrl = (config.oauthBaseUrl ?? "https://oauth.reddit.com").replace(/\/+$/, "");
    this.publicBaseUrl = (config.publicBaseUrl ?? "https://www.reddit.com").replace(/\/+$/, "");
    this.doFetch = config.fetch ?? (globalThis.fetch as unknown as RedditFetch);
  }

  get hasCredentials(): boolean {
    return Boolean(this.config.clientId?.trim() && this.config.clientSecret?.trim());
  }

  private clock(): number {
    return this.config.now ? this.config.now() : Date.now();
  }

  /** Client-credentials token, cached until shortly before it expires. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.clock()) return this.token.value;

    const basic = Buffer.from(
      `${this.config.clientId?.trim()}:${this.config.clientSecret?.trim()}`,
    ).toString("base64");

    const response = await this.doFetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": this.userAgent,
      },
      body: "grant_type=client_credentials",
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`reddit oauth failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) throw new Error("reddit oauth returned no access_token");

    // 60s of slack so a token cannot expire mid-scan.
    this.token = {
      value: parsed.access_token,
      expiresAt: this.clock() + Math.max(0, (parsed.expires_in ?? 3600) - 60) * 1000,
    };
    return this.token.value;
  }

  /**
   * Reddit's listing JSON → our normalized items.
   * Deleted/removed entries and stickied mod posts are skipped, not faked.
   */
  toItems(listing: RedditListing): SourceItem[] {
    const children = listing.data?.children ?? [];
    const items: SourceItem[] = [];

    for (const child of children) {
      const data = child.data;
      if (!data || !data.id) continue;
      if (data.stickied) continue;

      const title = data.title?.trim() ?? "";
      const body = data.selftext?.trim() ?? "";
      const content = body.length > 0 ? `${title}\n\n${body}`.trim() : title;
      // A post with neither text nor title carries nothing to analyse.
      if (content.length === 0) continue;
      // `[deleted]` / `[removed]` authors are noise, not people to contact.
      const rawAuthor = data.author?.trim() ?? "";
      const author = rawAuthor && !/^\[(deleted|removed)\]$/i.test(rawAuthor) ? `u/${rawAuthor}` : null;

      items.push({
        externalId: data.name ?? (data.id ? `t3_${data.id}` : null),
        title: title.length > 0 ? title : null,
        content,
        author,
        url: data.permalink ? `https://www.reddit.com${data.permalink}` : (data.url ?? null),
        createdAt: typeof data.created_utc === "number" ? new Date(data.created_utc * 1000) : null,
      });
    }

    return items;
  }

  async search({ query, limit }: AdapterQuery): Promise<SourceItem[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const params = new URLSearchParams({
      q: trimmed,
      sort: "new",
      limit: String(Math.min(Math.max(limit, 1), 100)),
      type: "link",
    });

    const authenticated = this.hasCredentials;
    const url = authenticated
      ? `${this.oauthBaseUrl}/search?${params.toString()}`
      : `${this.publicBaseUrl}/search.json?${params.toString()}`;

    const headers: Record<string, string> = {
      "user-agent": this.userAgent,
      accept: "application/json",
    };
    if (authenticated) headers.authorization = `Bearer ${await this.accessToken()}`;

    const response = await this.doFetch(url, { method: "GET", headers });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`reddit search failed (${response.status}): ${text.slice(0, 200)}`);
    }

    let listing: RedditListing;
    try {
      listing = JSON.parse(text) as RedditListing;
    } catch {
      throw new Error(`reddit search returned non-JSON: ${text.slice(0, 200)}`);
    }

    const items = this.toItems(listing);
    logger.info("reddit search finished", {
      query: trimmed,
      authenticated,
      returned: items.length,
    });
    return items;
  }

  async healthCheck(): Promise<AdapterHealth> {
    try {
      // One tiny search: enough to prove the endpoint and the credentials work.
      await this.search({ query: "need a website", limit: 1 });
      return {
        ok: true,
        detail: this.hasCredentials ? "OAuth client credentials accepted" : "public JSON endpoint reachable (no credentials configured)",
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: new Date(),
      };
    }
  }
}
