/**
 * Source adapters (Phase 2).
 *
 * The live Reddit call cannot run here (no credentials, and the network is not
 * part of a unit test), so these pin what can be checked offline: the request the
 * adapter builds, how a listing maps onto our normalized items, and how the hunt
 * runner behaves when a source fails or the AI budget runs out.
 */
import { describe, expect, it, vi } from "vitest";
import { RedditAdapter, type RedditFetch } from "@/src/sources/reddit";
import { runHunt, type HuntStore } from "@/src/sources/run";
import type { SourceAdapter, SourceItem } from "@/src/sources/types";
import { BudgetExceededError } from "@/src/ai";
import type { IngestResult } from "@/src/leads/pipeline";
import type { SourceKind } from "@/src/generated/prisma/enums";

type Captured = { url: string; headers: Record<string, string>; body?: string };

function stub(answer: (call: Captured, index: number) => { status: number; text: string }) {
  const calls: Captured[] = [];
  const fetchImpl: RedditFetch = async (url, init) => {
    const captured: Captured = { url, headers: init.headers, body: init.body };
    calls.push(captured);
    const { status, text } = answer(captured, calls.length - 1);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { calls, fetchImpl };
}

const listing = (children: unknown[]) => JSON.stringify({ data: { children } });

const post = (overrides: Record<string, unknown> = {}) => ({
  kind: "t3",
  data: {
    id: "abc123",
    name: "t3_abc123",
    title: "Need a WooCommerce store",
    selftext: "Budget around 2000 EUR, want it live this month.",
    author: "example_user",
    permalink: "/r/smallbusiness/comments/abc123/need_a_woocommerce_store/",
    created_utc: 1790000000,
    ...overrides,
  },
});

describe("RedditAdapter request shape", () => {
  it("uses the public JSON endpoint when no credentials are configured", async () => {
    const { calls, fetchImpl } = stub(() => ({ status: 200, text: listing([post()]) }));
    await new RedditAdapter({ fetch: fetchImpl }).search({ query: "need a website", limit: 10 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith("https://www.reddit.com/search.json?")).toBe(true);
    expect(calls[0].url).toContain("q=need+a+website");
    expect(calls[0].url).toContain("sort=new");
    expect(calls[0].url).toContain("limit=10");
    // Reddit rejects requests without a descriptive User-Agent.
    expect(calls[0].headers["user-agent"]).toBeTruthy();
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it("authenticates with OAuth client credentials when they are configured", async () => {
    const { calls, fetchImpl } = stub((_call, index) =>
      index === 0
        ? { status: 200, text: JSON.stringify({ access_token: "tok-123", expires_in: 3600 }) }
        : { status: 200, text: listing([post()]) },
    );

    const adapter = new RedditAdapter({ clientId: "id", clientSecret: "secret", fetch: fetchImpl });
    await adapter.search({ query: "woocommerce", limit: 10 });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://www.reddit.com/api/v1/access_token");
    expect(calls[0].body).toBe("grant_type=client_credentials");
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);

    expect(calls[1].url.startsWith("https://oauth.reddit.com/search?")).toBe(true);
    expect(calls[1].headers.authorization).toBe("Bearer tok-123");
  });

  it("reuses a cached token instead of re-authenticating for every query", async () => {
    const { calls, fetchImpl } = stub((_call, index) =>
      index === 0
        ? { status: 200, text: JSON.stringify({ access_token: "tok-123", expires_in: 3600 }) }
        : { status: 200, text: listing([post()]) },
    );

    const adapter = new RedditAdapter({ clientId: "id", clientSecret: "secret", fetch: fetchImpl });
    await adapter.search({ query: "one", limit: 5 });
    await adapter.search({ query: "two", limit: 5 });

    const tokenCalls = calls.filter((call) => call.url.includes("/api/v1/access_token"));
    expect(tokenCalls).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("clamps the limit to what the API accepts and refuses an empty query", async () => {
    const { calls, fetchImpl } = stub(() => ({ status: 200, text: listing([]) }));
    const adapter = new RedditAdapter({ fetch: fetchImpl });

    await adapter.search({ query: "x", limit: 5_000 });
    expect(calls[0].url).toContain("limit=100");

    expect(await adapter.search({ query: "   ", limit: 10 })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("fails loudly on a non-JSON or error response", async () => {
    const { fetchImpl } = stub(() => ({ status: 429, text: "slow down" }));
    await expect(new RedditAdapter({ fetch: fetchImpl }).search({ query: "x", limit: 1 })).rejects.toThrow(/429/);

    const { fetchImpl: badJson } = stub(() => ({ status: 200, text: "<html>nope</html>" }));
    await expect(new RedditAdapter({ fetch: badJson }).search({ query: "x", limit: 1 })).rejects.toThrow(/non-JSON/);
  });
});

describe("RedditAdapter mapping", () => {
  const adapter = new RedditAdapter({ fetch: stub(() => ({ status: 200, text: "{}" })).fetchImpl });

  it("normalizes a listing into our items", () => {
    const [item] = adapter.toItems(JSON.parse(listing([post()])));
    expect(item).toEqual({
      externalId: "t3_abc123",
      title: "Need a WooCommerce store",
      content: "Need a WooCommerce store\n\nBudget around 2000 EUR, want it live this month.",
      author: "u/example_user",
      url: "https://www.reddit.com/r/smallbusiness/comments/abc123/need_a_woocommerce_store/",
      createdAt: new Date(1790000000 * 1000),
    });
  });

  it("falls back to the title for a link post with no body", () => {
    const [item] = adapter.toItems(JSON.parse(listing([post({ selftext: "" })])));
    expect(item.content).toBe("Need a WooCommerce store");
  });

  it("skips stickied mod posts, deleted authors and empty posts rather than faking them", () => {
    const items = adapter.toItems(
      JSON.parse(
        listing([
          post({ stickied: true }),
          post({ id: "x", name: undefined, author: "[deleted]" }),
          post({ id: "y", title: "", selftext: "" }),
        ]),
      ),
    );

    expect(items).toHaveLength(1);
    // The author is dropped rather than shown as "[deleted]".
    expect(items[0].author).toBeNull();
    // `name` wins when present; the base id is the fallback.
    expect(items[0].externalId).toBe("t3_x");
  });
});

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

function fakeAdapter(
  name: string,
  items: SourceItem[],
  kind: SourceKind = "REDDIT",
  search?: () => Promise<SourceItem[]>,
): SourceAdapter {
  return {
    name,
    kind,
    search: search ?? (async () => items),
  };
}

function fakeStore(overrides: Partial<HuntStore> = {}): HuntStore & { marked: string[]; scanned: string[] } {
  const marked: string[] = [];
  const scanned: string[] = [];
  return {
    marked,
    scanned,
    enabledQueries: async () => [{ id: "q1", query: "need a website", sourceId: null }],
    sources: async () => [],
    markQueryRun: async (id) => {
      marked.push(id);
    },
    markSourceScan: async (id) => {
      scanned.push(id);
    },
    ...overrides,
  };
}

const item: SourceItem = {
  externalId: "t3_1",
  title: "Need a website",
  content: "Need a website for my bakery. Budget 2000 EUR.",
  author: "u/baker",
  url: "https://www.reddit.com/r/x/1",
  createdAt: new Date("2026-10-01T10:00:00Z"),
};

describe("runHunt", () => {
  it("feeds every found item through the pipeline with the adapter's identity", async () => {
    const seen: unknown[] = [];
    const summary = await runHunt({
      adapters: [fakeAdapter("reddit", [item])],
      store: fakeStore(),
      ingest: async (input) => {
        seen.push(input);
        return { outcome: "created", leadId: "lead-1", score: 93, temperature: "HOT", analysisStatus: "SUCCEEDED" } satisfies IngestResult;
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      content: item.content,
      title: item.title,
      sourceAuthor: "u/baker",
      sourceExternalId: "t3_1",
      sourceKind: "REDDIT",
      sourceName: "reddit",
    });

    expect(summary).toMatchObject({
      queriesRun: 1,
      discovered: 1,
      created: 1,
      duplicates: 0,
      invalid: 0,
      failed: 0,
      stopped: null,
    });
    expect(summary.leads[0]).toMatchObject({ leadId: "lead-1", score: 93, temperature: "HOT" });
  });

  it("counts duplicates and invalid items instead of hiding them", async () => {
    const results: IngestResult[] = [
      { outcome: "duplicate", leadId: "lead-1", reason: { code: "sameSourceItem" }, similarity: 1 },
      { outcome: "invalid", code: "contentEmpty" },
    ];
    let index = 0;

    const summary = await runHunt({
      adapters: [fakeAdapter("reddit", [item, item])],
      store: fakeStore(),
      ingest: async () => results[index++],
    });

    expect(summary).toMatchObject({ discovered: 2, created: 0, duplicates: 1, invalid: 1, failed: 0 });
  });

  it("keeps going when one adapter throws", async () => {
    const summary = await runHunt({
      adapters: [
        fakeAdapter("reddit", [], "REDDIT", async () => {
          throw new Error("reddit search failed (503)");
        }),
      ],
      store: fakeStore(),
      ingest: vi.fn(async () => ({ outcome: "invalid", code: "contentEmpty" }) as IngestResult),
    });

    expect(summary.errors).toEqual([{ adapter: "reddit", query: "need a website", message: "reddit search failed (503)" }]);
    expect(summary.discovered).toBe(0);
    // The query is still marked as run, so a broken source does not loop forever.
    expect((summary as unknown as { queriesRun: number }).queriesRun).toBe(1);
  });

  it("stops the whole run when the daily AI budget is exhausted", async () => {
    const summary = await runHunt({
      adapters: [fakeAdapter("reddit", [item, item, item])],
      store: fakeStore(),
      ingest: async () => {
        throw new BudgetExceededError(250);
      },
    });

    expect(summary.stopped).toBe("budgetExceeded");
    expect(summary.discovered).toBe(3);
    expect(summary.created).toBe(0);
  });

  it("writes nothing, and marks nothing, in a dry run", async () => {
    const store = fakeStore();
    const ingest = vi.fn(async () => ({ outcome: "created", leadId: "x", score: 1, temperature: "COLD", analysisStatus: "SUCCEEDED" }) as IngestResult);

    const summary = await runHunt({
      adapters: [fakeAdapter("reddit", [item])],
      store,
      ingest,
      dryRun: true,
    });

    expect(summary.discovered).toBe(1);
    expect(summary.created).toBe(0);
    expect(ingest).not.toHaveBeenCalled();
    expect(store.marked).toEqual([]);
  });

  it("only runs adapters that match a query's own source, and skips disabled ones", async () => {
    const store = fakeStore({
      enabledQueries: async () => [{ id: "q1", query: "woocommerce", sourceId: "s1" }],
      sources: async () => [{ id: "s1", adapter: "telegram", kind: "TELEGRAM" as SourceKind, enabled: true }],
    });

    const summary = await runHunt({
      adapters: [fakeAdapter("reddit", [item]), fakeAdapter("telegram", [])],
      store,
      ingest: vi.fn(async () => ({ outcome: "invalid", code: "contentEmpty" }) as IngestResult),
    });

    expect(summary.discovered).toBe(0);
    expect(summary.queriesRun).toBe(1);

    const disabled = fakeStore({
      enabledQueries: async () => [{ id: "q1", query: "x", sourceId: "s1" }],
      sources: async () => [{ id: "s1", adapter: "reddit", kind: "REDDIT" as SourceKind, enabled: false }],
    });
    const skipped = await runHunt({
      adapters: [fakeAdapter("reddit", [item])],
      store: disabled,
      ingest: vi.fn(async () => ({ outcome: "invalid", code: "contentEmpty" }) as IngestResult),
    });
    expect(skipped.discovered).toBe(0);
  });
});
