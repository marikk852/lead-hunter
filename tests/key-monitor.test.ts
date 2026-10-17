/**
 * The Settings key monitor probes the active provider with one tiny request.
 * These tests pin down the contract the UI relies on: a 401 is final and shown
 * verbatim, a 503 blip is retried exactly once, and transport failures end as a
 * reported result rather than an exception. Injected fetch/client only — no
 * network, no quota (§16: the default suite never depends on paid APIs).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "@/src/ai/providers/anthropic";
import {
  OpenAICompatibleProvider,
  type FetchLike,
} from "@/src/ai/providers/openai-compatible";

const OK_BODY = JSON.stringify({ choices: [{ message: { content: "pong" } }] });

function jsonReply(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/** Records what the provider sent; the mock's own typing stays out of the way. */
type Call = { url: string; body: string };

function recorder(
  respond: (call: number) => { ok: boolean; status: number; text(): Promise<string> },
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: String(url), body: String(init.body) });
    return respond(calls.length);
  };
  return { fetchImpl, calls };
}

function compatWith(fetchImpl: FetchLike) {
  return new OpenAICompatibleProvider({
    apiKey: "test-key",
    model: "test-model",
    fastModel: "test-fast",
    fetch: fetchImpl,
    // No real waiting in tests; the retry count is what matters.
    sleep: async () => {},
  });
}

describe("openai-compatible ping", () => {
  it("reports success with latency and sends a minimal completion", async () => {
    const { fetchImpl, calls } = recorder(() => jsonReply(200, OK_BODY));
    const provider = compatWith(fetchImpl);

    const result = await provider.ping();

    expect(result.ok).toBe(true);
    expect(result.detail).toBe("HTTP 200");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/chat\/completions$/);
    const body = JSON.parse(calls[0].body) as Record<string, unknown>;
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("treats an auth failure as final: one attempt, vendor message shown", async () => {
    const { fetchImpl, calls } = recorder(() =>
      jsonReply(401, JSON.stringify({ error: { message: "API key not valid" } })),
    );
    const provider = compatWith(fetchImpl);

    const result = await provider.ping();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("HTTP 401");
    expect(result.detail).toContain("API key not valid");
    expect(calls).toHaveLength(1);
  });

  it("retries a transient 503 once, then reports it", async () => {
    const { fetchImpl, calls } = recorder(() =>
      jsonReply(503, JSON.stringify({ error: { message: "high demand" } })),
    );
    const provider = compatWith(fetchImpl);

    const result = await provider.ping();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("503");
    expect(result.detail).toContain("(after 2 attempts)");
    expect(calls).toHaveLength(2);
  });

  it("ends a transport failure as a result, not an exception", async () => {
    const calls: Call[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), body: String(init.body) });
      throw new Error("socket hang up");
    };
    const provider = compatWith(fetchImpl);

    const result = await provider.ping();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("socket hang up");
    expect(calls).toHaveLength(2);
  });
});

describe("anthropic ping", () => {
  function anthropicWith(create: () => Promise<unknown>) {
    const client = { messages: { create } } as unknown as Pick<Anthropic, "messages">;
    return new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-test",
      fastModel: "claude-test-fast",
      effort: "high",
      client,
    });
  }

  it("reports success", async () => {
    const provider = anthropicWith(async () => ({ content: [] }));
    const result = await provider.ping();
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("ok");
  });

  it("treats 401 as final and surfaces the vendor message", async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error("authentication_error: invalid x-api-key"), {
        status: 401,
      });
    });
    const provider = anthropicWith(create);

    const result = await provider.ping();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("HTTP 401");
    expect(result.detail).toContain("invalid x-api-key");
    expect(create).toHaveBeenCalledTimes(1);
  });
});