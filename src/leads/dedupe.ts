/**
 * Duplicate detection (README §14).
 *
 * The same request often appears several times: reposted, reworded, or asked in
 * two communities. Messaging one person twice is the worst outcome, so the
 * thresholds lean towards merging when the *author* matches, and only merge
 * across different authors when the text is nearly identical.
 *
 * The decision function is pure; the database lookups live in the pipeline.
 */
import { normalizeAuthor, similarity } from "@/src/lib/text";

export type DedupeCandidate = {
  id: string;
  sourceId: string;
  sourceExternalId: string | null;
  sourceAuthor: string | null;
  contentHash: string;
  originalContent: string;
};

export type DedupeInput = {
  sourceId: string;
  sourceExternalId: string | null;
  sourceAuthor: string | null;
  contentHash: string;
  originalContent: string;
};

export type DedupeThresholds = {
  /** Same author, different wording (e.g. cross-posted by hand). */
  sameAuthor: number;
  /** Different author, near-identical text (e.g. someone reposts a friend's ask). */
  crossAuthor: number;
};

export const DEFAULT_THRESHOLDS: DedupeThresholds = {
  sameAuthor: 0.72,
  crossAuthor: 0.88,
};

/**
 * Why a candidate was judged a duplicate.
 *
 * These are codes, not prose: the activity log gets an English sentence derived
 * from them, while the UI renders its own translation. Keeping prose out of the
 * value also keeps it safe to put in a redirect URL.
 */
export type DedupeReason =
  | { code: "sameSourceItem" }
  | { code: "identicalText" }
  | { code: "overlapSameAuthor"; percent: number }
  | { code: "overlapOtherSource"; percent: number };

/** English rendering for the activity log and server logs. */
export function describeDedupeReason(reason: DedupeReason): string {
  switch (reason.code) {
    case "sameSourceItem":
      return "same source item";
    case "identicalText":
      return "identical normalized text";
    case "overlapSameAuthor":
      return `same author, ${reason.percent}% text overlap`;
    case "overlapOtherSource":
      return `${reason.percent}% text overlap with another source`;
  }
}

/** A duplicate always carries a reason; a non-duplicate never does. */
export type DedupeDecision =
  | { duplicateOfId: null; reason: null; similarity: number }
  | { duplicateOfId: string; reason: DedupeReason; similarity: number };

/**
 * Decides whether `input` duplicates anything in `candidates`.
 * Candidate order is significant: the first match wins, so callers should pass
 * the strongest candidates first.
 */
export function decideDuplicate(
  input: DedupeInput,
  candidates: DedupeCandidate[],
  thresholds: DedupeThresholds = DEFAULT_THRESHOLDS,
): DedupeDecision {
  const inputAuthor = normalizeAuthor(input.sourceAuthor);

  let best: DedupeDecision = { duplicateOfId: null, reason: null, similarity: 0 };

  for (const candidate of candidates) {
    // 1. Same platform object — the only exact signal available.
    if (
      candidate.sourceId === input.sourceId &&
      input.sourceExternalId &&
      candidate.sourceExternalId === input.sourceExternalId
    ) {
      return { duplicateOfId: candidate.id, reason: { code: "sameSourceItem" }, similarity: 1 };
    }

    if (candidate.id === input.sourceId) continue;

    // 2. Identical normalized content.
    if (candidate.contentHash === input.contentHash) {
      return { duplicateOfId: candidate.id, reason: { code: "identicalText" }, similarity: 1 };
    }

    // 3. Text similarity, with a looser bar when the author matches.
    const score = similarity(input.originalContent, candidate.originalContent);
    const sameAuthor = inputAuthor !== null && inputAuthor === normalizeAuthor(candidate.sourceAuthor);
    const threshold = sameAuthor ? thresholds.sameAuthor : thresholds.crossAuthor;

    if (score >= threshold && score > best.similarity) {
      best = {
        duplicateOfId: candidate.id,
        reason: sameAuthor
          ? { code: "overlapSameAuthor", percent: Number((score * 100).toFixed(0)) }
          : { code: "overlapOtherSource", percent: Number((score * 100).toFixed(0)) },
        similarity: score,
      };
    }
  }

  return best;
}
