import { describe, expect, it } from "vitest";
import {
  contentHash,
  excerpt,
  normalizeAuthor,
  normalizeText,
  similarity,
  tokenSetSimilarity,
  trigramSimilarity,
} from "@/src/lib/text";

describe("normalizeText", () => {
  it("lowercases, strips links, emoji and punctuation", () => {
    expect(normalizeText("Need a WEBSITE!! 🚀 https://example.com/x")).toBe("need a website");
  });

  it("collapses whitespace so formatting does not affect the fingerprint", () => {
    expect(normalizeText("need   a\n\nwebsite\tnow")).toBe("need a website now");
  });

  it("keeps non-latin letters", () => {
    expect(normalizeText("Ищу разработчика")).toBe("ищу разработчика");
  });
});

describe("contentHash", () => {
  it("is stable for equivalent phrasings that differ only in noise", () => {
    const a = contentHash("Looking for a WOOCOMMERCE dev!! https://x.co");
    const b = contentHash("looking for a woocommerce dev");
    expect(a).toBe(b);
  });

  it("differs for genuinely different requests", () => {
    expect(contentHash("need a shopify store")).not.toBe(contentHash("need a wordpress site"));
  });
});

describe("similarity", () => {
  it("scores a reworded duplicate highly", () => {
    const a = "I need a website for my restaurant with a menu and a booking form";
    const b = "Looking for someone to build my restaurant website, needs a menu and a booking form";
    expect(similarity(a, b)).toBeGreaterThan(0.5);
  });

  it("scores unrelated posts low", () => {
    const a = "I need a website for my restaurant";
    const b = "Why does my useEffect keep re-running?";
    expect(similarity(a, b)).toBeLessThan(0.35);
  });

  it("returns 1 for identical text and 0 for empty input", () => {
    expect(similarity("build me a bot", "build me a bot")).toBe(1);
    expect(similarity("", "something")).toBe(0);
  });

  it("exposes both underlying measures", () => {
    const a = "need a telegram bot for my shop";
    const b = "need a bot telegram for shop my";
    expect(tokenSetSimilarity(a, b)).toBe(1);
    expect(trigramSimilarity(a, b)).toBeGreaterThan(0.5);
  });
});

describe("normalizeAuthor", () => {
  it("strips platform prefixes and case", () => {
    expect(normalizeAuthor("u/ExampleUser")).toBe("exampleuser");
    expect(normalizeAuthor("@ExampleUser")).toBe("exampleuser");
    expect(normalizeAuthor("  ExampleUser  ")).toBe("exampleuser");
  });

  it("returns null for missing authors", () => {
    expect(normalizeAuthor(null)).toBeNull();
    expect(normalizeAuthor("   ")).toBeNull();
  });
});

describe("excerpt", () => {
  it("flattens and truncates with an ellipsis", () => {
    expect(excerpt("a\n\nb   c", 10)).toBe("a b c");
    expect(excerpt("abcdefghijklmnop", 5)).toHaveLength(5);
    expect(excerpt("abcdefghijklmnop", 5).endsWith("…")).toBe(true);
  });
});
