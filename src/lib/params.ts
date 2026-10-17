/**
 * Search-parameter readers.
 *
 * Next.js / URLSearchParams already percent-decode values, so these helpers
 * deliberately do NOT call `decodeURIComponent` again. Double-decoding throws
 * `URIError: URI malformed` on any value containing a bare `%` — for example
 * the "91% text overlap" reason we put in a redirect URL.
 */
export type SearchParams = Record<string, string | string[] | undefined>;

export function readParam(params: SearchParams, key: string): string | null {
  const value = params[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readNumberParam(params: SearchParams, key: string): number | undefined {
  const raw = readParam(params, key);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
