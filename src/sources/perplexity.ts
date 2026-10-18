/**
 * Perplexity Search API source adapter (Phase 2).
 *
 * Why the direct API and not an MCP server: an MCP connection configured in an
 * editor is not available to this Next.js process at runtime, while the Search
 * API is one documented HTTP endpoint (`POST https://api.perplexity.ai/search`)
 * and fits the existing `SourceAdapter` contract exactly.
 *
 * Honesty rules baked in here:
 *  - The API returns ordinary web search results (title/url/snippet). A snippet
 *    is NOT evidence that someone wants to buy anything, so this adapter never
 *    labels a result a lead. It stores the source URL and the snippet, and the
 *    normal pipeline (rules or model) makes the qualification decision.
 *  - Results are billed per successful request ($5 / 1,000 for standard search,
 *    $1 / 1,000 for fast), so the adapter is only built when a key is
 *    configured, `max_results` is capped to the documented 20, and one bad query
 *    cannot spend the whole budget.
 *  - Every result keeps its primary-source URL; nothing is rewritten.
 *
 * Docs: https://docs.perplexity.ai/api-reference/search-post
 */
import type { SourceKind } from "@/src/generated/prisma/enums";
import { logger } from "@/src/lib/logger";
import {
  SourceAdapterError,
  type AdapterHealth,
  type AdapterQuery,
  type SourceAdapter,
  type SourceItem,
} from "@/src/sources/types";

export const PERPLEXITY_ADAPTER_NAME = "perplexity";
export const PERPLEXITY_DEFAULT_BASE_URL = "https://api.perplexity.ai";
/** Documented cap for web/fast search. */
export const PERPLEXITY_MAX_RESULTS_CAP = 20;
const MAX_QUERY_LENGTH = 400;

export type PerplexityFetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
};

export type PerplexityFetch = (
  url: string,
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<PerplexityFetchResponse>;

export type PerplexityRecency = "hour" | "day" | "week" | "month" | "year";

export type PerplexityAdapterConfig = {
  apiKey: string;
  baseUrl?: string;
  /** Results requested per query (1-20). */
  maxResults?: number;
  /** Optional recency window; omitted when unset. */
  recency?: PerplexityRecency | null;
  searchType?: "web" | "fast";
  fetch?: PerplexityFetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** Response shape documented for `POST /search` (extra fields ignored). */
type PerplexityResponse = {
  id?: string;
  results?: Array<{
    title?: string;
    url?: string;
    snippet?: string;
    date?: string | null;
    last_updated?: string | null;
  }>;
  error?: { message?: string } | string;
};

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 4_000);
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export class PerplexityAdapter implements SourceAdapter {
  readonly name = PERPLEXITY_ADAPTER_NAME;
  readonly kind: SourceKind = "PERPLEXITY";

  private readonly baseUrl: string;
  private readonly maxResults: number;
  private readonly recency: PerplexityRecency | null;
  private readonly searchType: "web" | "fast";
  private readonly doFetch: PerplexityFetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: PerplexityAdapterConfig) {
    if (!config.apiKey?.trim()) {
      throw new Error("PerplexityAdapter requires PERPLEXITY_API_KEY");
    }
    this.baseUrl = (config.baseUrl ?? PERPLEXITY_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxResults = Math.min(
      Math.max(1, config.maxResults ?? 10),
      PERPLEXITY_MAX_RESULTS_CAP,
    );
    this.recency = config.recency ?? null;
    this.searchType = config.searchType ?? "web";
    this.doFetch = config.fetch ?? (globalThis.fetch as unknown as PerplexityFetch);
    this.timeoutMs = config.timeoutMs ?? 20_000;
    this.maxRetries = config.maxRetries ?? 1;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Search results → normalized items. No intent is inferred at this layer. */
  toItems(payload: PerplexityResponse): SourceItem[] {
    const items: SourceItem[] = [];

    for (const result of payload.results ?? []) {
      const url = result.url?.trim();
      if (!url) continue;
      // Only http(s) results are usable; the API should only return links, but
      // a defensive check keeps a broken row out of the database.
      if (!/^https?:\/\//i.test(url)) continue;

      const title = result.title?.trim() ?? "";
      const snippet = result.snippet?.trim() ?? "";
      const content = snippet.length > 0 ? `${title}\n\n${snippet}`.trim() : title;
      if (content.length === 0) continue;

      items.push({
        // The URL is the natural stable identity of a web result, and the
        // pipeline's @@unique([sourceId, sourceExternalId]) then makes a repeat
        // discovery a duplicate even if the snippet was rewritten.
        externalId: url,
        title: title.length > 0 ? title : null,
        content,
        author: null,
        url,
        createdAt: parseDate(result.date ?? result.last_updated),
      });
    }

    return items;
  }

  private async request(body: Record<string, unknown>, context: string): Promise<string> {
    let lastDetail = "no response";

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.doFetch(`${this.baseUrl}/search`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.apiKey.trim()}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await response.text();
        if (response.ok) return text;

        const code =
          response.status === 401 || response.status === 403
            ? "auth"
            : response.status === 429
              ? "rateLimited"
              : response.status === 400 || response.status === 422
                ? "http"
                : "http";
        lastDetail = `${context} failed (${response.status}): ${text.slice(0, 300) || "empty body"}`;
        logger.warn("perplexity request failed", { context, status: response.status, code });

        if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }

        throw new SourceAdapterError(lastDetail, code, response.status);
      } catch (error) {
        if (error instanceof SourceAdapterError) throw error;

        const aborted =
          (error instanceof Error && error.name === "AbortError") ||
          (typeof error === "object" &&
            error !== null &&
            "name" in error &&
            (error as { name?: string }).name === "AbortError");
        lastDetail = aborted
          ? `${context} timed out after ${this.timeoutMs} ms`
          : `${context} failed: ${error instanceof Error ? error.message : String(error)}`;

        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }

        throw new SourceAdapterError(lastDetail, aborted ? "timeout" : "network", undefined, undefined, error);
      } finally {
        clearTimeout(timer);
      }
    }

    throw new SourceAdapterError(lastDetail, "unknown");
  }

  async search({ query, limit }: AdapterQuery): Promise<SourceItem[]> {
    const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH);
    if (trimmed.length === 0) return [];

    const body: Record<string, unknown> = {
      query: trimmed,
      max_results: Math.min(this.maxResults, Math.max(1, limit)),
      search_type: this.searchType,
    };
    if (this.recency) body.search_recency_filter = this.recency;

    const text = await this.request(body, "perplexity search");

    let payload: PerplexityResponse;
    try {
      payload = JSON.parse(text) as PerplexityResponse;
    } catch {
      throw new SourceAdapterError(
        `perplexity search returned non-JSON: ${text.slice(0, 200)}`,
        "parse",
      );
    }

    const items = this.toItems(payload);
    logger.info("perplexity search finished", {
      query: trimmed,
      returned: items.length,
      searchType: this.searchType,
    });
    return items;
  }

  async healthCheck(): Promise<AdapterHealth> {
    try {
      await this.search({ query: "freelance web developer wanted", limit: 1 });
      return {
        ok: true,
        detail: `Perplexity Search API (${this.searchType}) accepted the key`,
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: new Date(),
        code: error instanceof SourceAdapterError ? error.code : "unknown",
      };
    }
  }
}

