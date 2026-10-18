/**
 * Perplexity Search API adapter — offline contract tests.
 *
 * Live calls are paid ($5/1,000 requests), so none are made here. These pin the
 * request the adapter sends (endpoint, bearer auth, documented body fields), the
 * mapping to normalized items, and the failure classes the run log depends on.
 */
import { describe, expect, it } from "vitest";
import { PerplexityAdapter, type PerplexityFetch } from "@/src/sources/perplexity";
import { SourceAdapterError } from "@/src/sources/types";

type Captured = { url: string; headers: Record<string, string>; body?: string };

function stub(answer: (call: Captured, index: number) => { status: number; text: string }) {
  const calls: Captured[] = [];
  const fetchImpl: PerplexityFetch = async (url, init) => {
    const captured: Captured = { url, headers: init.headers, body: init.body };
    calls.push(captured);
    const { status, text } = answer(captured, calls.length - 1);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { calls, fetchImpl };
}

const payload = (results: unknown[]) => JSON.stringify({ id: "abc", results });

describe("PerplexityAdapter request shape", () => {
  it("posts to /search with bearer auth and the documented fields", async () => {
    const { calls, fetchImpl } = stub(() => ({
      status: 200,
      text: payload([
        {
          title: "Need a Shopify developer",
          url: "https://example.com/post",
          snippet: "Looking for someone to build a store.",
          date: "2026-10-17",
        },
      ]),
    }));

    await new PerplexityAdapter({
      apiKey: "pplx-test",
      maxResults: 7,
      recency: "week",
      searchType: "fast",
      fetch: fetchImpl,
    }).search({ query: "shopify developer wanted", limit: 10 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.perplexity.ai/search");
    expect(calls[0].headers.authorization).toBe("Bearer pplx-test");
    expect(calls[0].headers["content-type"]).toBe("application/json");

    const body = JSON.parse(calls[0].body ?? "{}");
    expect(body).toEqual({
      query: "shopify developer wanted",
      // The adapter's own cap wins when the caller asks for more.
      max_results: 7,
      search_type: "fast",
      search_recency_filter: "week",
    });
  });

  it("clamps max_results to the documented 20 and never sends an empty query", async () => {
    const { calls, fetchImpl } = stub(() => ({ status: 200, text: payload([]) }));
    const adapter = new PerplexityAdapter({ apiKey: "k", maxResults: 99, fetch: fetchImpl });

    await adapter.search({ query: "x", limit: 50 });
    expect(JSON.parse(calls[0].body ?? "{}").max_results).toBe(20);

    await adapter.search({ query: "   ", limit: 10 });
    expect(calls).toHaveLength(1);
  });
});

describe("PerplexityAdapter mapping", () => {
  const adapter = new PerplexityAdapter({
    apiKey: "k",
    fetch: stub(() => ({ status: 200, text: payload([]) })).fetchImpl,
  });

  it("normalizes a result, keeping the primary URL as its identity", () => {
    const [item] = adapter.toItems({
      results: [
        {
          title: "Need a WooCommerce store",
          url: "https://example.com/a",
          snippet: "Budget around 2000 EUR.",
          date: "2026-10-17",
        },
      ],
    });

    expect(item).toEqual({
      externalId: "https://example.com/a",
      title: "Need a WooCommerce store",
      content: "Need a WooCommerce store\n\nBudget around 2000 EUR.",
      author: null,
      url: "https://example.com/a",
      createdAt: new Date("2026-10-17"),
    });
  });

  it("skips entries without a usable URL or content instead of inventing one", () => {
    const items = adapter.toItems({
      results: [
        { title: "", snippet: "", url: "https://example.com/empty" },
        { title: "no url", snippet: "text" },
        { title: "ftp", snippet: "text", url: "ftp://example.com/x" },
        { title: "kept", snippet: "", url: "https://example.com/kept" },
      ],
    });

    expect(items.map((item) => item.url)).toEqual(["https://example.com/kept"]);
  });
});

describe("PerplexityAdapter failures", () => {
  it("reports a bad key as an auth error without retrying", async () => {
    const { calls, fetchImpl } = stub(() => ({ status: 401, text: "invalid api key" }));

    await expect(
      new PerplexityAdapter({ apiKey: "bad", fetch: fetchImpl }).search({ query: "x", limit: 1 }),
    ).rejects.toMatchObject({ code: "auth", status: 401 });

    expect(calls).toHaveLength(1);
  });

  it("retries a 429 once and then succeeds", async () => {
    const delays: number[] = [];
    const { calls, fetchImpl } = stub((_call, index) =>
      index === 0
        ? { status: 429, text: "rate limited" }
        : {
            status: 200,
            text: payload([{ title: "t", snippet: "s", url: "https://example.com/x" }]),
          },
    );

    const items = await new PerplexityAdapter({
      apiKey: "k",
      maxRetries: 1,
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetch: fetchImpl,
    }).search({ query: "x", limit: 1 });

    expect(items).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
  });

  it("throws a classified timeout rather than hanging", async () => {
    const timeoutFetch: PerplexityFetch = async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    };

    await expect(
      new PerplexityAdapter({
        apiKey: "k",
        maxRetries: 0,
        timeoutMs: 5,
        fetch: timeoutFetch,
      }).search({ query: "x", limit: 1 }),
    ).rejects.toBeInstanceOf(SourceAdapterError);
  });
});
