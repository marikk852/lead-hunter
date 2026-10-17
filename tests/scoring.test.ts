import { describe, expect, it } from "vitest";
import type { LeadAnalysis, OwnerProfileFacts } from "@/src/ai/schemas";
import {
  FACTOR_WEIGHTS,
  HOT_THRESHOLD,
  NON_LEAD_CAP,
  temperatureFor,
  recencyScore,
  scoreLead,
} from "@/src/leads/scoring";

const profile: OwnerProfileFacts = {
  name: "Developer",
  services: ["WordPress", "WooCommerce"],
  experience: null,
  location: "Moldova",
  languages: ["English"],
  minimumBudget: 300,
  portfolio: [],
  tone: null,
};

function analysis(overrides: Partial<LeadAnalysis> = {}): LeadAnalysis {
  return {
    isLead: true,
    confidence: 0.9,
    category: "WOOCOMMERCE",
    projectDescription: "Online store for a local business with a product catalogue",
    intentScore: 90,
    budget: { min: 1000, max: 2000, currency: "EUR" },
    urgency: "HIGH",
    location: "Germany",
    businessType: "Construction",
    requirements: ["product catalog", "contact form", "payment integration"],
    painPoints: ["current website is outdated"],
    recommendedService: "WooCommerce store build",
    reasoning: "Explicit request with budget and deadline.",
    ...overrides,
  };
}

const strongContext = {
  sourceAuthor: "u/example",
  sourceUrl: "https://example.com/post",
  sourceCreatedAt: new Date(),
};

describe("weights", () => {
  it("sum to 100 exactly, as the spec requires", () => {
    const total = Object.values(FACTOR_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBe(100);
  });
});

describe("scoreLead", () => {
  it("puts a fully specified request in the HOT band", () => {
    const result = scoreLead(analysis(), strongContext, profile);
    expect(result.total).toBeGreaterThanOrEqual(HOT_THRESHOLD);
    expect(result.temperature).toBe("HOT");
  });

  it("caps a non-lead below the WARM threshold regardless of the other inputs", () => {
    const result = scoreLead(analysis({ isLead: false }), strongContext, profile);
    expect(result.total).toBeLessThanOrEqual(NON_LEAD_CAP);
    expect(result.temperature).toBe("COLD");
  });

  it("reports every factor with its weight and points", () => {
    const result = scoreLead(analysis(), strongContext, profile);
    expect(result.components).toHaveLength(Object.keys(FACTOR_WEIGHTS).length);
    for (const component of result.components) {
      expect(component.weight).toBe(FACTOR_WEIGHTS[component.factor]);
      expect(component.points).toBeCloseTo(component.normalized * component.weight, 1);
      expect(component.normalized).toBeGreaterThanOrEqual(0);
      expect(component.normalized).toBeLessThanOrEqual(1);
    }
    const sum = result.components.reduce((total, component) => total + component.points, 0);
    expect(result.total).toBe(Math.round(Math.max(0, Math.min(100, sum))));
  });

  it("rewards a stated budget and penalises one below the owner minimum", () => {
    const withBudget = scoreLead(analysis(), strongContext, profile);
    const withoutBudget = scoreLead(
      analysis({ budget: { min: 0, max: 0, currency: "" } }),
      strongContext,
      profile,
    );
    expect(withBudget.total).toBeGreaterThan(withoutBudget.total);

    // A budget below the owner's minimum must score lower than one at or above it.
    const budgetPoints = (lead: LeadAnalysis) =>
      scoreLead(lead, strongContext, profile).components.find(
        (component) => component.factor === "budget",
      )?.normalized ?? 0;

    const belowMinimum = budgetPoints(analysis({ budget: { min: 50, max: 100, currency: "EUR" } }));
    const aboveMinimum = budgetPoints(analysis({ budget: { min: 1000, max: 2000, currency: "EUR" } }));

    expect(belowMinimum).toBeLessThan(aboveMinimum);
    expect(aboveMinimum).toBe(1);
  });

  it("scores an unknown contact channel lower than a reachable one", () => {
    const unreachable = scoreLead(analysis(), { sourceAuthor: null, sourceUrl: null }, profile);
    expect(unreachable.total).toBeLessThan(scoreLead(analysis(), strongContext, profile).total);
  });

  it("reflects urgency ordering", () => {
    const high = scoreLead(analysis({ urgency: "HIGH" }), strongContext, profile);
    const low = scoreLead(analysis({ urgency: "LOW" }), strongContext, profile);
    expect(high.total).toBeGreaterThan(low.total);
  });
});

describe("recencyScore", () => {
  const now = new Date("2026-10-15T12:00:00Z");

  it("decays with age and defaults when unknown", () => {
    expect(recencyScore(new Date("2026-10-15T10:00:00Z"), now)).toBe(1);
    expect(recencyScore(new Date("2026-10-14T12:00:00Z"), now)).toBe(1);
    expect(recencyScore(new Date("2026-10-01T12:00:00Z"), now)).toBe(0.6);
    expect(recencyScore(new Date("2026-01-01T12:00:00Z"), now)).toBe(0.15);
    expect(recencyScore(null, now)).toBe(0.4);
  });
});

describe("temperatureFor", () => {
  it("uses the documented bands", () => {
    expect(temperatureFor(80)).toBe("HOT");
    expect(temperatureFor(79.9)).toBe("WARM");
    expect(temperatureFor(50)).toBe("WARM");
    expect(temperatureFor(49)).toBe("COLD");
  });
});
