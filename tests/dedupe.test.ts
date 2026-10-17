import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  decideDuplicate,
  describeDedupeReason,
  type DedupeCandidate,
} from "@/src/leads/dedupe";
import { contentHash } from "@/src/lib/text";

const SOURCE_A = "source-a";
const SOURCE_B = "source-b";

function candidate(overrides: Partial<DedupeCandidate> = {}): DedupeCandidate {
  return {
    id: "lead-1",
    sourceId: SOURCE_A,
    sourceExternalId: "abc123",
    sourceAuthor: "u/ExampleUser",
    contentHash: contentHash("I need a website for my restaurant"),
    originalContent: "I need a website for my restaurant",
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof decideDuplicate>[0]> = {}) {
  return {
    sourceId: SOURCE_A,
    sourceExternalId: null,
    sourceAuthor: null,
    contentHash: contentHash("something else entirely"),
    originalContent: "something else entirely",
    ...overrides,
  };
}

describe("decideDuplicate", () => {
  it("returns no match for an empty candidate list", () => {
    expect(decideDuplicate(input(), []).duplicateOfId).toBeNull();
  });

  it("matches the same platform item even when the text was edited", () => {
    const decision = decideDuplicate(
      input({ sourceId: SOURCE_A, sourceExternalId: "abc123", originalContent: "edited text" }),
      [candidate()],
    );
    expect(decision.duplicateOfId).toBe("lead-1");
    expect(decision.reason).toEqual({ code: "sameSourceItem" });
    if (!decision.reason) throw new Error("expected a duplicate reason");
    // The activity log still gets a readable sentence for the same decision.
    expect(describeDedupeReason(decision.reason)).toBe("same source item");
    expect(decision.similarity).toBe(1);
  });

  it("matches identical normalized text", () => {
    const text = "Looking for a WOOCOMMERCE dev!!";
    const decision = decideDuplicate(
      input({
        sourceId: SOURCE_B,
        contentHash: contentHash(text),
        originalContent: text,
      }),
      [candidate({ contentHash: contentHash(text), originalContent: "looking for a woocommerce dev" })],
    );
    expect(decision.reason).toEqual({ code: "identicalText" });
  });

  it("matches the same author with reworded text above the author threshold", () => {
    const original =
      "We need someone to build a booking system for our salon, with online payments and reminders";
    const reposted =
      "Our salon needs a booking system built by someone, online payments and reminders included";
    const decision = decideDuplicate(
      input({ sourceAuthor: "u/ExampleUser", originalContent: reposted, contentHash: contentHash(reposted) }),
      [candidate({ originalContent: original, contentHash: contentHash(original) })],
    );
    expect(decision.duplicateOfId).toBe("lead-1");
    expect(decision.similarity).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.sameAuthor);
  });

  it("does not merge a different author with merely similar text", () => {
    const original = "I need a website for my restaurant with online ordering";
    const other = "I need a website for my restaurant with a photo gallery";
    const decision = decideDuplicate(
      input({ sourceAuthor: "u/SomeoneElse", originalContent: other, contentHash: contentHash(other) }),
      [candidate({ sourceAuthor: "u/ExampleUser", originalContent: original, contentHash: contentHash(original) })],
    );
    expect(decision.duplicateOfId).toBeNull();
  });

  it("merges near-identical text across different authors", () => {
    const text =
      "Need a Telegram bot for our shop that takes orders and sends them to a spreadsheet with daily reports";
    const decision = decideDuplicate(
      input({ sourceAuthor: "u/UserTwo", originalContent: text, contentHash: contentHash(text) }),
      [
        candidate({
          id: "lead-2",
          sourceAuthor: "u/UserOne",
          originalContent: text,
          contentHash: contentHash(text),
        }),
      ],
    );
    expect(decision.duplicateOfId).toBe("lead-2");
  });

  it("prefers the first matching candidate in the given order", () => {
    const text = "I need a shopify store for my clothing brand with 200 products";
    const decision = decideDuplicate(
      input({ originalContent: text, contentHash: contentHash(text) }),
      [
        candidate({ id: "first", originalContent: text, contentHash: contentHash(text) }),
        candidate({ id: "second", originalContent: text, contentHash: contentHash(text) }),
      ],
    );
    expect(decision.duplicateOfId).toBe("first");
  });

  it("reports a reworded repost as structured overlap, not prose", () => {
    const original =
      "We need someone to build a booking system for our salon, with online payments and reminders";
    const reposted =
      "Our salon needs a booking system built by someone, online payments and reminders included";
    const decision = decideDuplicate(
      input({ sourceAuthor: "u/ExampleUser", originalContent: reposted, contentHash: contentHash(reposted) }),
      [candidate({ originalContent: original, contentHash: contentHash(original) })],
    );

    expect(decision.reason).toHaveProperty("code", "overlapSameAuthor");
    if (!decision.reason || !("percent" in decision.reason)) {
      throw new Error("expected an overlap reason with a percentage");
    }
    expect(decision.reason.percent).toBeGreaterThan(0);
    expect(describeDedupeReason(decision.reason)).toMatch(/same author, \d+% text overlap/);
  });

  it("accepts custom thresholds", () => {
    const original = "I need a website for my restaurant with online ordering";
    const other = "I need a website for my restaurant";
    const candidates = [candidate({ originalContent: original, contentHash: contentHash(original) })];
    const strict = decideDuplicate(
      input({ originalContent: other, contentHash: contentHash(other) }),
      candidates,
      { sameAuthor: 1, crossAuthor: 1 },
    );
    expect(strict.duplicateOfId).toBeNull();
  });
});
