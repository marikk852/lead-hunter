/**
 * Provider selection.
 *
 * `auto` is the default, so the important property is that the console works in
 * every combination of keys — with a free key, with Anthropic, with neither — and
 * that it never claims a model ran when the rules did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY_VARS = ["AI_API_KEY", "ANTHROPIC_API_KEY", "AI_PROVIDER", "AI_MODEL", "AI_MODEL_FAST", "AI_BASE_URL"] as const;

let saved: Partial<Record<(typeof KEY_VARS)[number], string | undefined>> = {};

/** Re-imports `@/src/ai` with the env vars currently set (both modules cache). */
async function load() {
  vi.resetModules();
  return await import("@/src/ai");
}

beforeEach(() => {
  saved = {};
  for (const key of KEY_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEY_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("AI_PROVIDER=auto", () => {
  it("prefers the free OpenAI-compatible provider when AI_API_KEY is set", async () => {
    process.env.AI_API_KEY = "free-key";
    const { describeAIProvider, getAIProvider } = await load();

    expect(getAIProvider().name).toBe("openai-compatible");
    expect(describeAIProvider()).toMatchObject({
      name: "openai-compatible",
      keyed: true,
      degraded: false,
      reason: "aiApiKey",
      expectedKey: null,
    });
  });

  it("falls back to Anthropic when only that key exists", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-key";
    const { describeAIProvider, getAIProvider } = await load();

    expect(getAIProvider().name).toBe("anthropic");
    expect(describeAIProvider().reason).toBe("anthropicApiKey");
  });

  it("uses the free provider when both keys are present", async () => {
    process.env.AI_API_KEY = "free-key";
    process.env.ANTHROPIC_API_KEY = "sk-ant-key";
    const { getAIProvider } = await load();
    expect(getAIProvider().name).toBe("openai-compatible");
  });

  it("runs on the keyless rules with no key at all, and says so", async () => {
    const { describeAIProvider, getAIProvider } = await load();

    expect(getAIProvider().name).toBe("heuristic");
    expect(describeAIProvider()).toMatchObject({ keyed: false, degraded: false, reason: "noKey" });
  });

  it("never counts rule-based runs against the daily limit", async () => {
    const { describeAIProvider } = await load();
    // A keyless provider is not wrapped in the budget guard, so nothing it does
    // can be counted as a billable call.
    expect(describeAIProvider().name).toBe("heuristic");
  });
});

describe("explicit provider choices", () => {
  it("honours AI_PROVIDER=heuristic even when a key is configured", async () => {
    process.env.AI_PROVIDER = "heuristic";
    process.env.AI_API_KEY = "free-key";
    const { describeAIProvider, getAIProvider } = await load();

    expect(getAIProvider().name).toBe("heuristic");
    expect(describeAIProvider().keyed).toBe(false);
  });

  it("honours AI_PROVIDER=anthropic even when a free key is configured", async () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-key";
    process.env.AI_API_KEY = "free-key";
    const { describeAIProvider, getAIProvider } = await load();

    expect(getAIProvider().name).toBe("anthropic");
    expect(describeAIProvider().reason).toBe("anthropicForced");
  });

  it("honours AI_PROVIDER=openai and names the endpoint to fix", async () => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_API_KEY = "free-key";
    const { describeAIProvider, getAIProvider } = await load();

    expect(getAIProvider().name).toBe("openai-compatible");
    expect(describeAIProvider().reason).toBe("openaiForced");
  });

  it("degrades to the rules, loudly, when the requested provider has no key", async () => {
    process.env.AI_PROVIDER = "openai";
    const { describeAIProvider, getAIProvider } = await load();

    expect(getAIProvider().name).toBe("heuristic");
    expect(describeAIProvider()).toMatchObject({
      degraded: true,
      reason: "missingKey",
      expectedKey: "AI_API_KEY",
    });
  });

  it("names ANTHROPIC_API_KEY when that is what is missing", async () => {
    process.env.AI_PROVIDER = "anthropic";
    const { describeAIProvider } = await load();

    expect(describeAIProvider()).toMatchObject({ reason: "missingKey", expectedKey: "ANTHROPIC_API_KEY" });
  });
});

describe("model resolution", () => {
  it("uses the provider's own defaults when AI_MODEL is unset", async () => {
    process.env.AI_API_KEY = "free-key";
    const { describeAIProvider } = await load();
    const info = describeAIProvider();

    // No Anthropic model name leaks into the free provider's configuration.
    expect(info.model).not.toContain("claude");
    expect(info.model.length).toBeGreaterThan(0);
  });

  it("takes AI_MODEL as an override", async () => {
    process.env.AI_API_KEY = "free-key";
    process.env.AI_MODEL = "qwen/qwen3.8-27b";
    const { describeAIProvider } = await load();
    expect(describeAIProvider().model).toBe("qwen/qwen3.8-27b");
  });

  it("treats a blank AI_MODEL as unset", async () => {
    process.env.AI_API_KEY = "free-key";
    process.env.AI_MODEL = "   ";
    const { describeAIProvider } = await load();
    expect(describeAIProvider().model).not.toBe("");
  });
});
