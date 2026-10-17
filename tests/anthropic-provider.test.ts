/**
 * The network call to Claude cannot run without an API key, so these tests pin
 * everything that *can* be checked offline: the request shape, cache breakpoint
 * placement, schema validation of the response, and the 400 fallback path.
 */
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicProvider,
  supportsAdaptiveThinking,
  supportsEffort,
} from "@/src/ai/providers/anthropic";
import { AIProviderError } from "@/src/ai/types";
import type { LeadAnalysis, OwnerProfileFacts } from "@/src/ai/schemas";

const analysis: LeadAnalysis = {
  isLead: true,
  confidence: 0.92,
  category: "WOOCOMMERCE",
  projectDescription: "Online store for a construction company",
  intentScore: 93,
  budget: { min: 2000, max: 2000, currency: "EUR" },
  urgency: "HIGH",
  location: "Germany",
  businessType: "Construction",
  requirements: ["product catalog"],
  painPoints: [],
  recommendedService: "WooCommerce store build",
  reasoning: "Explicit request with budget and deadline.",
};

const profile: OwnerProfileFacts = {
  name: "Ana",
  services: ["WooCommerce"],
  experience: null,
  location: "Moldova",
  languages: ["English"],
  minimumBudget: 500,
  portfolio: [],
  tone: null,
};

const lead = {
  content: "Need a WooCommerce store for our construction company.",
  sourceKind: "REDDIT",
  sourceAuthor: "u/example",
  sourceCreatedAt: new Date("2026-10-01T10:00:00Z"),
  sourceUrl: "https://example.com/post/1",
};

type ParseArgs = Parameters<Anthropic["messages"]["parse"]>[0];

function createProvider(parse: (params: ParseArgs) => Promise<unknown>) {
  return new AnthropicProvider({
    apiKey: "test-key",
    model: "claude-opus-4-7",
    fastModel: "claude-haiku-4-5",
    effort: "high",
    client: { messages: { parse } } as unknown as Pick<Anthropic, "messages">,
  });
}

describe("model capability guards", () => {
  it("knows which models accept effort", () => {
    expect(supportsEffort("claude-opus-4-7")).toBe(true);
    expect(supportsEffort("claude-sonnet-4-6")).toBe(true);
    expect(supportsEffort("claude-haiku-4-5")).toBe(false);
    expect(supportsEffort("claude-sonnet-4-5")).toBe(false);
  });

  it("knows which models support adaptive thinking", () => {
    expect(supportsAdaptiveThinking("claude-opus-4-7")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-4-6")).toBe(true);
    expect(supportsAdaptiveThinking("claude-haiku-4-5")).toBe(false);
  });
});

describe("analyzeLead request shape", () => {
  let calls: ParseArgs[];

  beforeEach(() => {
    calls = [];
  });

  it("caches the frozen system prompt and keeps the lead after the breakpoint", async () => {
    const provider = createProvider(async (params) => {
      calls.push(params);
      return { parsed_output: analysis, usage: { input_tokens: 10, output_tokens: 5 } };
    });

    await provider.analyzeLead(lead);

    expect(calls).toHaveLength(1);
    const params = calls[0];

    expect(params.model).toBe("claude-opus-4-7");
    // Structured output is requested through output_config.format.
    expect(params.output_config?.format).toBeDefined();
    expect(params.output_config?.effort).toBe("high");

    // Cache breakpoint on the last system block; nothing volatile in it.
    const system = params.system as Array<{ text: string; cache_control?: unknown }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    // Nothing that identifies this specific lead may sit in the cached prefix.
    expect(system.at(-1)?.text).not.toContain("u/example");
    expect(system.at(-1)?.text).not.toContain("https://example.com/post/1");

    // The lead itself is in messages, i.e. after the breakpoint.
    const messages = params.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("WooCommerce store for our construction company");

    expect(params.thinking).toEqual({ type: "adaptive" });
  });

  it("maps token usage including cache counters", async () => {
    const provider = createProvider(async () => ({
      parsed_output: analysis,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 0,
      },
    }));

    const outcome = await provider.analyzeLead(lead);
    expect(outcome.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 4000,
      cacheCreationInputTokens: 0,
    });
  });

  it("re-validates the provider's output and rejects a malformed payload", async () => {
    const provider = createProvider(async () => ({
      // confidence out of range and a category that is not in the taxonomy
      parsed_output: { ...analysis, confidence: 7, category: "NOT_A_CATEGORY" },
    }));

    await expect(provider.analyzeLead(lead)).rejects.toThrow();
  });

  it("fails loudly when the model returns no parseable output", async () => {
    const provider = createProvider(async () => ({ parsed_output: null, stop_reason: "refusal" }));
    await expect(provider.analyzeLead(lead)).rejects.toBeInstanceOf(AIProviderError);
  });

  it("retries without adaptive thinking after a 400 response", async () => {
    let attempt = 0;
    const provider = createProvider(async (params) => {
      attempt += 1;
      calls.push(params);
      if (attempt === 1) {
        throw new Anthropic.BadRequestError(
          400,
          { error: { message: "thinking not supported" } },
          "thinking not supported",
          new Headers(),
        );
      }
      return { parsed_output: analysis };
    });

    const outcome = await provider.analyzeLead(lead);

    expect(attempt).toBe(2);
    expect(calls[0]?.thinking).toEqual({ type: "adaptive" });
    expect(calls[1]?.thinking).toBeUndefined();
    expect(outcome.notes.join(" ")).toContain("retried without adaptive thinking");
  });

  it("does not swallow a non-400 error", async () => {
    const provider = createProvider(async () => {
      throw new Anthropic.AuthenticationError(
        401,
        { error: { message: "bad key" } },
        "bad key",
        new Headers(),
      );
    });

    await expect(provider.analyzeLead(lead)).rejects.toBeInstanceOf(AIProviderError);
  });
});

describe("generateResponse", () => {
  it("omits effort for models that reject it and extracts the text blocks", async () => {
    const created: Array<Record<string, unknown>> = [];
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-haiku-4-5",
      fastModel: "claude-haiku-4-5",
      effort: "high",
      client: {
        messages: {
          create: async (params: Record<string, unknown>) => {
            created.push(params);
            return {
              content: [
                { type: "text", text: "Hi! You mentioned a WooCommerce store." },
                { type: "text", text: "What is your deadline?" },
              ],
              usage: { input_tokens: 12, output_tokens: 8 },
            };
          },
        },
      } as unknown as Pick<Anthropic, "messages">,
    });

    const outcome = await provider.generateResponse({
      lead,
      analysis,
      profile,
      adjust: null,
    });

    expect(outcome.body).toBe(
      "Hi! You mentioned a WooCommerce store.\nWhat is your deadline?",
    );
    expect(created[0]?.output_config).toBeUndefined();

    // Instructions first, semi-static profile second, breakpoint on the last block.
    const system = created[0]?.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system).toHaveLength(2);
    expect(system[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]?.text).toContain("Ana");
  });

  it("refuses to return an empty draft", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-opus-4-7",
      fastModel: "claude-haiku-4-5",
      effort: "high",
      client: {
        messages: { create: vi.fn(async () => ({ content: [] })) },
      } as unknown as Pick<Anthropic, "messages">,
    });

    await expect(
      provider.generateResponse({ lead, analysis, profile, adjust: null }),
    ).rejects.toBeInstanceOf(AIProviderError);
  });
});
