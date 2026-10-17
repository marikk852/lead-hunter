/**
 * The free OpenAI-compatible provider. There is no key in this environment, so
 * these tests pin everything that can be checked offline: the request shape per
 * vendor-degradation step, the local re-validation of the answer, usage mapping
 * and the error paths. The network itself stays unverified (see docs/IMPLEMENTATION.md).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPAT_BASE_URL,
  OpenAICompatibleProvider,
  parseJsonAnswer,
  strictJsonSchema,
  type FetchLike,
} from "@/src/ai/providers/openai-compatible";
import { LeadAnalysisSchema, type LeadAnalysis, type OwnerProfileFacts } from "@/src/ai/schemas";
import { ANALYSIS_SYSTEM_PROMPT } from "@/src/ai/prompts";
import { AIProviderError } from "@/src/ai/types";
import { z } from "zod";

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

type Captured = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

/** A fetch stub that records requests and answers from a script. */
function stubFetch(
  answer: (call: Captured, index: number) => { status: number; payload: unknown },
) {
  const calls: Captured[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const captured: Captured = { url, body, headers: init.headers };
    calls.push(captured);
    const { status, payload } = answer(captured, calls.length - 1);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
  };
  return { calls, fetchImpl };
}

function provider(fetchImpl: FetchLike, overrides: Record<string, unknown> = {}) {
  return new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "strong-model",
    fastModel: "fast-model",
    fetch: fetchImpl,
    ...overrides,
  });
}

function ok(content: unknown, usage: Record<string, unknown> = {}) {
  return {
    status: 200,
    payload: {
      choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }],
      usage,
    },
  };
}

function responseFormatOf(body: Record<string, unknown>) {
  return body.response_format as { type?: string; json_schema?: { strict?: boolean; schema?: Record<string, unknown> } } | undefined;
}

describe("strictJsonSchema", () => {
  it("closes every object and lists all of its properties as required", () => {
    const schema = strictJsonSchema(
      z.object({
        name: z.string(),
        nested: z.object({ a: z.number(), b: z.array(z.object({ c: z.string() })) }),
      }),
    ) as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<
        string,
        {
          additionalProperties?: boolean;
          required?: string[];
          properties?: Record<string, { items?: { additionalProperties?: boolean; required?: string[] } }>;
        }
      >;
    };

    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["name", "nested"]);

    const nested = schema.properties.nested;
    expect(nested.additionalProperties).toBe(false);
    expect(nested.required).toEqual(["a", "b"]);
    // Arrays are walked too — strict mode validates items the same way.
    const items = nested.properties?.b.items;
    expect(items?.additionalProperties).toBe(false);
    expect(items?.required).toEqual(["c"]);
  });

  it("describes the real analysis schema completely", () => {
    const schema = strictJsonSchema(LeadAnalysisSchema) as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("parseJsonAnswer", () => {
  it("accepts a bare object, a fenced block and surrounded prose", () => {
    expect(parseJsonAnswer('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonAnswer('Here you go:\n{"a":1}\nHope that helps')).toEqual({ a: 1 });
  });

  it("throws when there is no object at all", () => {
    expect(() => parseJsonAnswer("I cannot help with that.")).toThrow();
  });
});

describe("analyzeLead request shape", () => {
  it("asks for strict JSON-schema output and keeps the frozen prefix reusable", async () => {
    const { calls, fetchImpl } = stubFetch(() => ok(analysis, { prompt_tokens: 10, completion_tokens: 5 }));
    await provider(fetchImpl).analyzeLead(lead);

    expect(calls).toHaveLength(1);
    const { url, body, headers } = calls[0];

    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer test-key");
    expect(body.model).toBe("strong-model");
    // The local schema carrier must not leak into the wire format.
    expect(body.jsonSchema).toBeUndefined();

    const format = responseFormatOf(body);
    expect(format?.type).toBe("json_schema");
    expect(format?.json_schema?.strict).toBe(true);
    // The schema is the app's own Zod-derived one, not a free-form hint.
    expect(format?.json_schema?.schema).toHaveProperty("properties.isLead");

    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe(ANALYSIS_SYSTEM_PROMPT);
    // Nothing that identifies one lead may sit in the cacheable prefix.
    expect(messages[0].content).not.toContain("u/example");
    expect(messages[1].content).toContain("WooCommerce store for our construction company");
    expect(messages[1].content).toContain("u/example");
  });

  it("normalizes a base URL that carries a trailing slash", async () => {
    const { calls, fetchImpl } = stubFetch(() => ok(analysis));
    await provider(fetchImpl, { baseUrl: "https://example.test/v1/" }).analyzeLead(lead);
    expect(calls[0].url).toBe("https://example.test/v1/chat/completions");
  });

  it("falls back to the documented default endpoint and models", async () => {
    const described = new OpenAICompatibleProvider({ apiKey: "k", fetch: stubFetch(() => ok(analysis)).fetchImpl }).describe();
    expect(described.baseUrl).toBe(DEFAULT_COMPAT_BASE_URL);
    expect(described.model).toBeTruthy();
    expect(described.fastModel).toBeTruthy();
  });

  it("maps usage, including a reported prefix-cache hit", async () => {
    const { fetchImpl } = stubFetch(() =>
      ok(analysis, {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 4000 },
      }),
    );

    const outcome = await provider(fetchImpl).analyzeLead(lead);
    expect(outcome.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 4000,
      cacheCreationInputTokens: 0,
    });
    expect(outcome.provider).toBe("openai-compatible");
    expect(outcome.model).toBe("strong-model");
  });

  it("accepts the alternate cache counter some vendors use", async () => {
    const { fetchImpl } = stubFetch(() => ok(analysis, { prompt_tokens: 7, completion_tokens: 3, prompt_cache_hit_tokens: 900 }));
    const outcome = await provider(fetchImpl).analyzeLead(lead);
    expect(outcome.usage?.cacheReadInputTokens).toBe(900);
  });

  it("re-validates the answer itself and rejects a payload that merely looks right", async () => {
    const { fetchImpl } = stubFetch(() => ok({ ...analysis, category: "NOT_A_CATEGORY", intentScore: 400 }));
    await expect(provider(fetchImpl).analyzeLead(lead)).rejects.toThrow();
  });

  it("rejects a non-JSON answer loudly", async () => {
    const { fetchImpl } = stubFetch(() => ok("Sorry, I cannot do that."));
    await expect(provider(fetchImpl).analyzeLead(lead)).rejects.toBeInstanceOf(AIProviderError);
  });

  it("fails when the model returns no content", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 200, payload: { choices: [{ message: { refusal: "no" }, finish_reason: "stop" }] } }));
    await expect(provider(fetchImpl).analyzeLead(lead)).rejects.toBeInstanceOf(AIProviderError);
  });
});

describe("transient failures", () => {
  const noSleep = async () => {};

  it("retries a 503 and recovers, recording it in the notes", async () => {
    const { calls, fetchImpl } = stubFetch((_call, index) =>
      index === 0
        ? { status: 503, payload: { error: { message: "This model is currently experiencing high demand" } } }
        : ok(analysis),
    );

    const outcome = await provider(fetchImpl, { sleep: noSleep }).analyzeLead(lead);

    expect(calls).toHaveLength(2);
    expect(outcome.analysis.isLead).toBe(true);
    expect(outcome.notes.join(" ")).toContain("recovered after 1 transient failure");
  });

  it("keeps the same request shape while retrying — a 503 is not a shape problem", async () => {
    const { calls, fetchImpl } = stubFetch((_call, index) =>
      index === 0
        ? { status: 429, payload: { error: { message: "rate limited" } } }
        : ok(analysis),
    );

    await provider(fetchImpl, { sleep: noSleep }).analyzeLead(lead);

    expect(calls).toHaveLength(2);
    expect(responseFormatOf(calls[0].body)?.type).toBe("json_schema");
    expect(responseFormatOf(calls[1].body)?.type).toBe("json_schema");
  });

  it("gives up after the configured attempts and reports the last error", async () => {
    const { calls, fetchImpl } = stubFetch(() => ({
      status: 503,
      payload: { error: { message: "still high demand" } },
    }));

    await expect(provider(fetchImpl, { sleep: noSleep }).analyzeLead(lead)).rejects.toThrow(/503/);
    expect(calls).toHaveLength(3); // one attempt + two retries
  });

  it("does not retry an error that retrying cannot fix", async () => {
    const { calls, fetchImpl } = stubFetch(() => ({
      status: 401,
      payload: { error: { message: "invalid api key" } },
    }));

    await expect(provider(fetchImpl, { sleep: noSleep }).analyzeLead(lead)).rejects.toThrow(/401/);
    expect(calls).toHaveLength(1);
  });

  it("retries a dropped connection", async () => {
    let attempt = 0;
    const fetchImpl: FetchLike = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("ECONNRESET");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(analysis) }, finish_reason: "stop" }],
          }),
      };
    };

    const outcome = await provider(fetchImpl, { sleep: noSleep }).analyzeLead(lead);
    expect(outcome.analysis.intentScore).toBe(93);
    expect(attempt).toBe(2);
  });

  it("can be turned off", async () => {
    const { calls, fetchImpl } = stubFetch(() => ({
      status: 503,
      payload: { error: { message: "nope" } },
    }));

    await expect(
      provider(fetchImpl, { sleep: noSleep, maxRetries: 0 }).analyzeLead(lead),
    ).rejects.toThrow(/503/);
    expect(calls).toHaveLength(1);
  });
});

describe("structured-output degradation", () => {
  it("retries with json_object when the vendor rejects a strict schema", async () => {
    const { calls, fetchImpl } = stubFetch((_call, index) =>
      index === 0
        ? { status: 400, payload: { error: { message: "response_format json_schema is not supported" } } }
        : ok(analysis),
    );

    const outcome = await provider(fetchImpl).analyzeLead(lead);

    expect(calls).toHaveLength(2);
    expect(responseFormatOf(calls[0].body)?.json_schema?.strict).toBe(true);
    expect(responseFormatOf(calls[1].body)?.type).toBe("json_object");
    expect(outcome.analysis.isLead).toBe(true);
    expect(outcome.notes.join(" ")).toContain('degraded to "json_object"');
  });

  it("drops response_format entirely for a vendor that accepts neither shape", async () => {
    const { calls, fetchImpl } = stubFetch((_call, index) =>
      index < 2 ? { status: 400, payload: { error: { message: "unknown parameter: response_format" } } } : ok(analysis),
    );

    const outcome = await provider(fetchImpl).analyzeLead(lead);

    expect(calls).toHaveLength(3);
    expect(calls[2].body.response_format).toBeUndefined();
    expect(outcome.analysis.intentScore).toBe(93);
    expect(outcome.notes.join(" ")).toContain('degraded to "plain"');
  });

  it("does not retry an authentication failure", async () => {
    const { calls, fetchImpl } = stubFetch(() => ({ status: 401, payload: { error: { message: "invalid api key" } } }));
    await expect(provider(fetchImpl).analyzeLead(lead)).rejects.toThrow(/401/);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a server error", async () => {
    const { calls, fetchImpl } = stubFetch(() => ({ status: 500, payload: { error: { message: "upstream exploded" } } }));
    await expect(provider(fetchImpl).analyzeLead(lead)).rejects.toBeInstanceOf(AIProviderError);
    expect(calls).toHaveLength(1);
  });
});

describe("screen", () => {
  it("uses the cheap tier and validates its smaller schema", async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      ok({ isCandidate: true, confidence: 0.7, reason: "asks for a developer" }),
    );

    const outcome = await provider(fetchImpl).screen(lead);
    expect(calls[0].body.model).toBe("fast-model");
    expect(calls[0].body.max_tokens).toBe(512);
    expect(outcome.screen.isCandidate).toBe(true);
  });
});

describe("generateResponse", () => {
  it("sends prose instructions with the profile after them and no response_format", async () => {
    const { calls, fetchImpl } = stubFetch(() => ok("Hi! You mentioned a WooCommerce store. What is your deadline?", { prompt_tokens: 12, completion_tokens: 8 }));
    const outcome = await provider(fetchImpl).generateResponse({ lead, analysis, profile, adjust: null });

    const body = calls[0].body;
    expect(body.response_format).toBeUndefined();
    expect(body.model).toBe("strong-model");

    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(3);
    // Instructions are stable; the profile is semi-static and follows them.
    expect(messages[0].content).not.toContain("Ana");
    expect(messages[1].content).toContain("Ana");
    expect(messages[2].content).toContain("WooCommerce store");
    expect(outcome.body).toContain("deadline");
  });

  it("refuses to return an empty draft", async () => {
    const { fetchImpl } = stubFetch(() => ok("   "));
    await expect(provider(fetchImpl).generateResponse({ lead, analysis, profile, adjust: null })).rejects.toBeInstanceOf(AIProviderError);
  });
});
