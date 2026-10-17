import { describe, expect, it } from "vitest";
import {
  detectBusinessType,
  detectCategory,
  detectUrgency,
  extractBudget,
  extractRequirements,
  heuristicAnalyze,
  parseAmount,
  scoreEvidence,
  collectEvidence,
} from "@/src/ai/providers/heuristic";

/** The canonical cases from README §7. */
const STRONG =
  "Need a WooCommerce store for our construction company. Budget is around €2,000 and I want it live this month. We have about 40 products.";
const WEAK = "I'm thinking about maybe getting a website for my bakery one day. Is it worth it?";
const NOT_A_LEAD = [
  "Websites are expensive these days.",
  "Anyone here knows React?",
  "I made a website yesterday.",
  "Developers are overrated.",
  "Anyone know a good React course? Want to get better at hooks.",
  "Why does my useEffect keep re-running? This is driving me crazy.",
];

describe("analyze — README §7 examples", () => {
  it("classifies the strong example as a HOT lead with budget and urgency", () => {
    const analysis = heuristicAnalyze({ content: STRONG, sourceKind: "MANUAL" });
    expect(analysis.isLead).toBe(true);
    expect(analysis.intentScore).toBeGreaterThanOrEqual(80);
    expect(analysis.category).toBe("WOOCOMMERCE");
    expect(analysis.urgency).toBe("HIGH");
    expect(analysis.budget.currency).toBe("EUR");
    expect(analysis.budget.max).toBeGreaterThanOrEqual(2000);
    expect(analysis.businessType).toBe("Construction");
    expect(analysis.confidence).toBeGreaterThan(0.5);
  });

  it("classifies the weak example as a lead with a low score", () => {
    const analysis = heuristicAnalyze({ content: WEAK, sourceKind: "MANUAL" });
    expect(analysis.isLead).toBe(true);
    expect(analysis.intentScore).toBeLessThan(50);
    expect(analysis.businessType).toBe("Bakery");
  });

  it.each(NOT_A_LEAD)("rejects: %s", (text) => {
    const analysis = heuristicAnalyze({ content: text, sourceKind: "MANUAL" });
    expect(analysis.isLead).toBe(false);
    expect(analysis.intentScore).toBeLessThan(35);
  });

  it("ignores a vendor advertising their own services", () => {
    const analysis = heuristicAnalyze({
      content:
        "I'm a developer with 8 years of experience building Shopify stores. DM me if you need a website built.",
      sourceKind: "MANUAL",
    });
    expect(analysis.isLead).toBe(false);
  });

  it("keeps a paid-project request even though it says hiring", () => {
    const analysis = heuristicAnalyze({
      content:
        "We're hiring a freelancer for a two-week Shopify migration. Budget is $3,000, starting next week.",
      sourceKind: "MANUAL",
    });
    expect(analysis.isLead).toBe(true);
    expect(analysis.budget.max).toBe(3000);
    expect(analysis.urgency).toBe("HIGH");
  });

  it("still finds a lead when a broken system needs paid help", () => {
    const analysis = heuristicAnalyze({
      content:
        "Our Shopify checkout is broken since the theme update and we are losing sales daily. Need someone to fix it.",
      sourceKind: "MANUAL",
    });
    expect(analysis.isLead).toBe(true);
    expect(analysis.intentScore).toBeGreaterThanOrEqual(50);
  });

  it("explains its reasoning without claiming a model was used", () => {
    const analysis = heuristicAnalyze({ content: STRONG, sourceKind: "MANUAL" });
    expect(analysis.reasoning).toContain("budget");
    expect(analysis.reasoning).toContain("deterministic");
  });
});

describe("extractBudget", () => {
  it("reads symbol amounts, ranges and shorthand", () => {
    expect(extractBudget("Budget is around €2,000")).toMatchObject({ min: 2000, max: 2000, currency: "EUR" });
    expect(extractBudget("budget $1,000-2,000")).toMatchObject({ min: 1000, max: 2000, currency: "USD" });
    expect(extractBudget("we can pay 1.5k for this")).toMatchObject({ max: 1500 });
    expect(extractBudget("£800 budget")).toMatchObject({ max: 800, currency: "GBP" });
  });

  it("does not invent a budget from unrelated numbers", () => {
    expect(extractBudget("We have 40 products and 3 staff")).toEqual({ min: 0, max: 0, currency: "" });
    expect(extractBudget("I have 8 years of experience")).toEqual({ min: 0, max: 0, currency: "" });
  });

  it("returns nothing when no money is discussed", () => {
    expect(extractBudget("I need a website for my bakery")).toEqual({ min: 0, max: 0, currency: "" });
  });
});

describe("parseAmount", () => {
  it("handles thousands separators, decimals and k-suffix", () => {
    expect(parseAmount("2,000")).toBe(2000);
    expect(parseAmount("2.000")).toBe(2000);
    expect(parseAmount("1.5k")).toBe(1500);
    expect(parseAmount("1500")).toBe(1500);
    expect(parseAmount("€800")).toBe(800);
    expect(parseAmount("abc")).toBeNull();
  });
});

describe("detectCategory", () => {
  it("prefers specific platforms over generic forms", () => {
    expect(detectCategory("need a woocommerce store")).toBe("WOOCOMMERCE");
    expect(detectCategory("looking for shopify help")).toBe("SHOPIFY");
    expect(detectCategory("need a telegram bot")).toBe("TELEGRAM_BOT");
    expect(detectCategory("need a mobile app for ios")).toBe("MOBILE_APP");
    expect(detectCategory("my site is slow")).toBe("PERFORMANCE");
    expect(detectCategory("need a plain website")).toBe("WEBSITE");
    expect(detectCategory("hello world")).toBe("OTHER");
  });
});

describe("detectUrgency", () => {
  it("orders the signals correctly", () => {
    expect(detectUrgency("need it asap")).toBe("HIGH");
    expect(detectUrgency("want it live this month")).toBe("HIGH");
    expect(detectUrgency("in a few weeks would be fine")).toBe("MEDIUM");
    expect(detectUrgency("no rush at all")).toBe("LOW");
    expect(detectUrgency("someday")).toBe("LOW");
    expect(detectUrgency("just asking")).toBe("UNKNOWN");
  });
});

describe("detectBusinessType", () => {
  it("recognises common trades", () => {
    expect(detectBusinessType("website for my construction company")).toBe("Construction");
    expect(detectBusinessType("my salon needs bookings")).toBe("Salon / beauty");
    expect(detectBusinessType("we run a dental clinic")).toBe("Clinic");
    expect(detectBusinessType("just a person with an idea")).toBe("");
  });
});

describe("extractRequirements", () => {
  it("pulls concrete deliverables and drops chatter", () => {
    const requirements = extractRequirements(
      "Need a shop with a product catalog, online payments, and a contact form. I am based in Berlin and I like coffee.",
    );
    expect(requirements.length).toBeGreaterThan(0);
    expect(requirements.join(" ").toLowerCase()).toContain("product catalog");
    expect(requirements.join(" ").toLowerCase()).not.toContain("coffee");
  });
});

describe("scoreEvidence", () => {
  it("is monotonic: adding evidence never lowers the score", () => {
    const base = scoreEvidence(collectEvidence("we might need a website"));
    const stronger = scoreEvidence(collectEvidence("we need a website for our shop"));
    const strongest = scoreEvidence(
      collectEvidence("we need a website for our shop, budget is €5,000, need it this month"),
    );
    expect(stronger.score).toBeGreaterThanOrEqual(base.score);
    expect(strongest.score).toBeGreaterThan(stronger.score);
  });

  it("never exceeds 0-100", () => {
    const scored = scoreEvidence(
      collectEvidence(
        "We need a developer to build a WooCommerce store for our company with payments and a catalog, budget €9,000, urgent, this week.",
      ),
    );
    expect(scored.score).toBeLessThanOrEqual(100);
    expect(scored.score).toBeGreaterThanOrEqual(0);
  });
});
