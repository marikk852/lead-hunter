/**
 * Text utilities for normalization, fingerprinting and similarity.
 * Used by duplicate detection (README §14).
 */
import { createHash } from "node:crypto";

const URL_PATTERN = /https?:\/\/\S+/g;
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu;

/**
 * Normalizes free-form post text so that two phrasings of the same request
 * compare equal: lowercased, links/emoji stripped, punctuation flattened,
 * whitespace collapsed.
 */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(URL_PATTERN, " ")
    .replace(EMOJI_PATTERN, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable fingerprint of normalized content. */
export function contentHash(input: string): string {
  return createHash("sha256").update(normalizeText(input)).digest("hex");
}

export function tokens(input: string): string[] {
  return normalizeText(input)
    .split(" ")
    .filter((token) => token.length > 1);
}

/** Jaccard overlap of the two token sets: 0 (disjoint) to 1 (identical). */
export function tokenSetSimilarity(a: string, b: string): number {
  const setA = new Set(tokens(a));
  const setB = new Set(tokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

function trigrams(input: string): Set<string> {
  const padded = ` ${normalizeText(input)} `;
  const out = new Set<string>();
  for (let i = 0; i + 2 < padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

/** Character-trigram cosine similarity — catches reordered wording. */
export function trigramSimilarity(a: string, b: string): number {
  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const gram of setA) if (setB.has(gram)) shared += 1;
  return shared / Math.sqrt(setA.size * setB.size);
}

/**
 * Combined similarity used by duplicate detection. Deliberately the more
 * forgiving of the two measures, because the cost of a missed duplicate
 * (double outreach to one person) is higher than a slightly eager merge
 * (which always stays visible to the owner).
 */
export function similarity(a: string, b: string): number {
  return Math.max(tokenSetSimilarity(a, b), trigramSimilarity(a, b));
}

/** Normalizes an author handle for comparison across sources. */
export function normalizeAuthor(author: string | null | undefined): string | null {
  if (!author) return null;
  const cleaned = author
    .toLowerCase()
    .replace(/^u\//, "")
    .replace(/^@/, "")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** First `max` characters of text with an ellipsis when truncated. */
export function excerpt(input: string, max = 160): string {
  const flat = input.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
