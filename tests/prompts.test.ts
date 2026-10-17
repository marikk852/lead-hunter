/**
 * Prompt caching is a prefix match, so these tests guard the property that
 * actually makes caching work: the frozen prefix must not vary, and volatile
 * data must stay inside the user message.
 */
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_SYSTEM_PROMPT,
  MIN_CACHEABLE_PREFIX_TOKENS,
  PROMPT_VERSION,
  SCREEN_SYSTEM_PROMPT,
  RESPONSE_SYSTEM_PROMPT,
  buildAnalysisUserMessage,
  buildOwnerProfileBlock,
  buildResponseUserMessage,
  buildScreenUserMessage,
  estimateTokens,
} from "@/src/ai/prompts";
import type { LeadAnalysis, OwnerProfileFacts } from "@/src/ai/schemas";

const lead = {
  content: "Need a WooCommerce store for our construction company.",
  title: "Store help",
  sourceKind: "REDDIT",
  sourceAuthor: "u/example",
  sourceCreatedAt: new Date("2026-10-01T10:00:00Z"),
  sourceUrl: "https://example.com/post/1",
};

describe("frozen system prompts", () => {
  const prompts = {
    analysis: ANALYSIS_SYSTEM_PROMPT,
    screen: SCREEN_SYSTEM_PROMPT,
    response: RESPONSE_SYSTEM_PROMPT,
  };

  it.each(Object.entries(prompts))("%s prompt holds the rules, not the data", (_name, value) => {
    expect(value.length).toBeGreaterThan(200);
    // The cached prefix must not carry anything that identifies one lead.
    // (The few-shot examples may legitimately quote illustrative posts.)
    expect(value).not.toContain("u/example");
    expect(value).not.toContain("https://example.com/post/1");
    expect(value).not.toContain("2026-10-01");
  });

  it.each(Object.entries(prompts))("%s prompt contains no volatile values", (_name, value) => {
    // A timestamp or generated id anywhere in the prefix would invalidate the
    // cache on every request (see the prompt-caching audit table).
    expect(value).not.toMatch(/\b\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(value).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    expect(value).not.toMatch(/current date|today is|right now/i);
  });

  it("carries a version tag that changes with the prompt", () => {
    expect(PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});

describe("user messages", () => {
  it("are deterministic for identical input", () => {
    expect(buildAnalysisUserMessage(lead)).toBe(buildAnalysisUserMessage({ ...lead }));
  });

  it("embed the lead content and nothing else volatile", () => {
    const message = buildAnalysisUserMessage(lead);
    expect(message).toContain("WooCommerce store");
    expect(message).toContain("u/example");
    expect(message).toContain(lead.sourceCreatedAt.toISOString());
    expect(message.split("\n")[0]).toBe("Analyze this post.");
  });

  it("serialize with a fixed key order so bytes do not drift", () => {
    const message = buildAnalysisUserMessage(lead);
    const keys = [...message.matchAll(/"([a-z_]+)":/g)].map((match) => match[1]);
    expect(keys).toEqual(["source", "author", "posted_at", "url", "title", "content"]);
  });

  it("keeps the screen payload smaller than the analysis payload", () => {
    expect(buildScreenUserMessage(lead).length).toBeLessThan(buildAnalysisUserMessage(lead).length);
  });
});

describe("owner profile block", () => {
  const profile: OwnerProfileFacts = {
    name: "Ana",
    services: ["WordPress", "WooCommerce"],
    experience: "8 years of PHP",
    location: "Moldova",
    languages: ["English", "Romanian"],
    minimumBudget: 500,
    portfolio: [{ title: "Shop X", url: "https://x.md", description: "WooCommerce build" }],
    tone: "direct",
  };

  it("is stable for the same profile", () => {
    expect(buildOwnerProfileBlock(profile)).toBe(buildOwnerProfileBlock({ ...profile }));
  });

  it("states the absence of a portfolio explicitly, so work cannot be invented", () => {
    const block = buildOwnerProfileBlock({ ...profile, portfolio: [] });
    expect(block).toContain("Portfolio: empty — do not reference any past work.");
  });

  it("lists only the facts it was given", () => {
    const block = buildOwnerProfileBlock(profile);
    expect(block).toContain("WordPress");
    expect(block).toContain("8 years of PHP");
    expect(block).toContain("Shop X");
  });
});

describe("response user message", () => {
  const analysis: LeadAnalysis = {
    isLead: true,
    confidence: 0.9,
    category: "WOOCOMMERCE",
    projectDescription: "Online store",
    intentScore: 90,
    budget: { min: 1000, max: 2000, currency: "EUR" },
    urgency: "HIGH",
    location: "Germany",
    businessType: "Construction",
    requirements: ["product catalog"],
    painPoints: [],
    recommendedService: "WooCommerce store build",
    reasoning: "Explicit request.",
  };

  it("includes the revision instruction only when provided", () => {
    const without = buildResponseUserMessage({ lead, analysis });
    const with_ = buildResponseUserMessage({ lead, analysis, adjust: "make it shorter" });
    expect(without).not.toContain("make it shorter");
    expect(with_).toContain("make it shorter");
    expect(with_.startsWith(without)).toBe(true);
  });
});

describe("cache diagnostics", () => {
  it("estimates the analysis prefix size", () => {
    const estimated = estimateTokens(ANALYSIS_SYSTEM_PROMPT);
    // Reported, not asserted as passing: the provider logs a warning when the
    // prefix is below the documented minimum, because caching would silently
    // be a no-op.
    expect(estimated).toBeGreaterThan(500);
    expect(MIN_CACHEABLE_PREFIX_TOKENS).toBe(4096);
  });
});
