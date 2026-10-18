/**
 * Reddit adapter (Phase 2, README §5).
 *
 * Read-only, and deliberately credential-tolerant:
 *  - with `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` it uses the documented
 *    OAuth2 client-credentials flow against `oauth.reddit.com`;
 *  - without them it falls back to the public JSON search endpoint.
 *
 * As of Reddit's current Data API policy, unauthenticated programmatic access is
 * blocked (this network receives HTTP 403 on `search.json`), so the public path
 * is a best-effort fallback and NOT the supported route. Register a free
 * "script" app at reddit.com/prefs/apps and set the two credentials.
 *
 * No vendor SDK: plain `fetch` behind an injectable seam, so the request shape is
 * testable offline. Nothing is posted, voted on or messaged — this only reads.
 *
 * Failure handling is explicit rather than silent: every call has a timeout, a
 * 429/5xx gets a bounded exponential backoff (honouring `Retry-After`), and the
 * thrown error carries a machine-readable code so a run can distinguish
 * "rate-limited" from "bad credentials" from "Reddit returned HTML".
 */
import type { SourceKind } from "@/src/generated/prisma/enums";
import { logger } from "@/src/lib/logger";
import {
  SourceAdapterError,
  sourceErrorForStatus,
  type AdapterHealth,
  type AdapterQuery,
  type SourceAdapter,
  type SourceItem,
} from "@/src/sources/types";

export const REDDIT_ADAPTER_NAME = "reddit";

/** The API rejects requests without a descriptive, unique User-Agent. */
export const DEFAULT_USER_AGENT = "lead-hunter/0.1 (personal use)";

export type RedditFetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** Optional so a minimal test stub does not have to fake headers. */
  headers?: { get(name: string): string | null };
};

export type RedditFetch = (
  url: string,
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<RedditFetchResponse>;

export type RedditAdapterConfig = {
  clientId?: string | null;
  clientSecret?: string | null;
  userAgent?: string;
  /** OAuth host for authenticated calls. */
  oauthBaseUrl?: string;
  /** Public host used when no credentials are configured. */
  publicBaseUrl?: string;
  fetch?: RedditFetch;
  /** Milliseconds before a single attempt is abandoned. */
  timeoutMs?: number;
  /** Extra attempts for transient failures (429/5xx/network). */
  maxRetries?: number;
  /** Test seam so retry tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
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

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** `Retry-After` is either seconds or an HTTP date; cap it so a run cannot stall. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - now), 60_000);
  return null;
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 4_000);
}

export class RedditAdapter implements SourceAdapter {
  readonly name = REDDIT_ADAPTER_NAME;
  readonly kind: SourceKind = "REDDIT";

  private readonly userAgent: string;
  private readonly oauthBaseUrl: string;
  private readonly publicBaseUrl: string;
  private readonly doFetch: RedditFetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: RedditAdapterConfig = {}) {
    this.userAgent = config.userAgent?.trim() || DEFAULT_USER_AGENT;
    this.oauthBaseUrl = (config.oauthBaseUrl ?? "https://oauth.reddit.com").replace(/\/+$/, "");
    this.publicBaseUrl = (config.publicBaseUrl ?? "https://www.reddit.com").replace(/\/+$/, "");
    this.doFetch = config.fetch ?? (globalThis.fetch as unknown as RedditFetch);
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get hasCredentials(): boolean {
    return Boolean(this.config.clientId?.trim() && this.config.clientSecret?.trim());
  }

  private clock(): number {
    return this.config.now ? this.config.now() : Date.now();
  }

  /**
   * One HTTP call with a timeout and bounded retry for transient failures.
   * Returns the response body; throws a classified `SourceAdapterError` otherwise.
   */
  private async request(
    url: string,
    init: { method?: string; headers: Record<string, string>; body?: string },
    context: string,
  ): Promise<string> {
    let lastDetail = "no response";

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.doFetch(url, { ...init, signal: controller.signal });
        const text = await response.text();

        if (response.ok) return text;

        const status = response.status;
        const code = sourceErrorForStatus(status);
        const retryAfterMs = parseRetryAfter(response.headers?.get("retry-after") ?? null, this.clock());
        lastDetail = `${context} failed (${status}): ${text.slice(0, 200) || "empty body"}`;
        logger.warn("reddit request failed", { context, status, code, retryAfterMs });

        if (isRetryableStatus(status) && attempt < this.maxRetries) {
          await this.sleep(retryAfterMs ?? backoffMs(attempt));
          continue;
        }

        throw new SourceAdapterError(lastDetail, code, status, retryAfterMs ?? undefined);
      } catch (error) {
        if (error instanceof SourceAdapterError) throw error;

        const aborted =
          (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message))) ||
          (typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "AbortError");
        lastDetail = aborted
          ? `${context} timed out after ${this.timeoutMs} ms`
          : `${context} failed: ${error instanceof Error ? error.message : String(error)}`;

        logger.warn("reddit transport failure", { context, attempt, detail: lastDetail });
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }

        throw new SourceAdapterError(
          lastDetail,
          aborted ? "timeout" : "network",
          undefined,
          undefined,
          error,
        );
      } finally {
        clearTimeout(timer);
      }
    }

    // Unreachable: every loop path either returns or throws.
    throw new SourceAdapterError(lastDetail, "unknown");
  }

  /** Client-credentials token, cached until shortly before it expires. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.clock()) return this.token.value;

    const basic = Buffer.from(
      `${this.config.clientId?.trim()}:${this.config.clientSecret?.trim()}`,
    ).toString("base64");

    const text = await this.request(
      "https://www.reddit.com/api/v1/access_token",
      {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": this.userAgent,
        },
        body: "grant_type=client_credentials",
      },
      "reddit oauth",
    );

    let parsed: { access_token?: string; expires_in?: number };
    try {
      parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    } catch {
      throw new SourceAdapterError(
        `reddit oauth returned non-JSON: ${text.slice(0, 200)}`,
        "parse",
      );
    }

    if (!parsed.access_token) {
      throw new SourceAdapterError("reddit oauth returned no access_token", "auth");
    }

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
      // Without this Reddit escapes HTML entities in `selftext`, so the same
      // post normalizes differently than on a second fetch.
      raw_json: "1",
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

    const text = await this.request(url, { method: "GET", headers }, "reddit search");

    let listing: RedditListing;
    try {
      listing = JSON.parse(text) as RedditListing;
    } catch {
      throw new SourceAdapterError(
        `reddit search returned non-JSON: ${text.slice(0, 200)}`,
        "parse",
      );
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
        detail: this.hasCredentials
          ? "OAuth client credentials accepted"
          : "public JSON endpoint reachable (no credentials configured)",
        checkedAt: new Date(),
      };
    } catch (error) {
      const code = error instanceof SourceAdapterError ? error.code : "unknown";
      const hint =
        code === "auth" && !this.hasCredentials
          ? " — Reddit now blocks unauthenticated programmatic search; set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET"
          : code === "rateLimited"
            ? " — rate limited; the next scheduled run will retry"
            : "";
      return {
        ok: false,
        detail: `${error instanceof Error ? error.message : String(error)}${hint}`,
        checkedAt: new Date(),
        code,
      };
    }
  }
}
