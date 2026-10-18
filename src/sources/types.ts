/**
 * The source-adapter contract (README §5, Phase 2).
 *
 * An adapter's whole job is to turn "a saved search query" into a list of public
 * items. Everything after that — dedupe, analysis, scoring, storage — already
 * exists in `src/leads/pipeline.ts`, so a new source is additive: implement this
 * interface, register the adapter in `src/sources/registry.ts`, done.
 *
 * Adapters never send anything and never touch the database. They return plain
 * data, which makes them testable with an injected `fetch`.
 */
import type { SourceKind } from "@/src/generated/prisma/enums";

/** One public post/message, normalized across sources. */
export type SourceItem = {
  /** Stable id at the source, used for exact-duplicate detection. */
  externalId: string | null;
  title: string | null;
  content: string;
  /** Display name as the source shows it (`u/name`, `@handle`, …). */
  author: string | null;
  url: string | null;
  /** When the source says it was published — used for recency scoring. */
  createdAt: Date | null;
};

export type AdapterQuery = {
  query: string;
  /** Upper bound on items returned for this query. */
  limit: number;
};

export type AdapterHealth = {
  ok: boolean;
  /** Short human-readable detail, e.g. "authenticated as script app". */
  detail: string;
  checkedAt: Date;
  /** Machine-readable failure class, so the UI and run log can group failures. */
  code?: SourceErrorCode;
};

/**
 * Why an adapter call failed. The runner stores this next to the error text so
 * "rate-limited" is distinguishable from "bad credentials" in the run log —
 * they need different responses from the owner.
 */
export type SourceErrorCode =
  | "rateLimited"
  | "timeout"
  | "auth"
  | "http"
  | "network"
  | "parse"
  | "unknown";

/** An adapter failure the runner can classify without parsing a message. */
export class SourceAdapterError extends Error {
  constructor(
    message: string,
    readonly code: SourceErrorCode,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SourceAdapterError";
  }
}

/** Maps an HTTP status to the failure class the owner cares about. */
export function sourceErrorForStatus(status: number): SourceErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rateLimited";
  if (status >= 500) return "http";
  return "http";
}

export interface SourceAdapter {
  /** Slug stored on `Source.adapter` ("reddit", "telegram", …). */
  readonly name: string;
  readonly kind: SourceKind;
  /** Reads public items. Must not throw for a single malformed item. */
  search(query: AdapterQuery): Promise<SourceItem[]>;
  /** Optional diagnostics for the settings screen. */
  healthCheck?(): Promise<AdapterHealth>;
}
