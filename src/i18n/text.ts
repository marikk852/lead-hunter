/**
 * Pure text helpers: no cookies, no `next/headers`, so they can be imported by
 * a client component, a test, or the login screen without a request context.
 *
 * `src/i18n/index.ts` adds the request-scoped part (reading the locale cookie)
 * and re-exports everything here.
 */
import type { Locale } from "@/src/i18n/config";
import { en, type Dictionary } from "@/src/i18n/en";

/** Replaces `{name}` placeholders. Keeps sentences whole for translators. */
export function template(input: string, params: Record<string, string | number>): string {
  return input.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

export type PluralForms = { one: string; few: string; many: string };

/**
 * Which form a count takes. English only distinguishes one from the rest, so it
 * never reaches for `few`; Russian needs the second form for 2–4 ("2 фильтра",
 * "5 фильтров"), which is why every plural string carries three variants.
 */
function pluralCategory(locale: Locale, count: number): keyof PluralForms {
  const n = Math.abs(count);
  if (locale !== "ru") return n === 1 ? "one" : "many";
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "one";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
  return "many";
}

/**
 * Picks the right plural form for the active locale:
 *
 *   plural("ru", 1, f) → "1 лид"      plural("ru", 3, f) → "3 лида"
 *   plural("ru", 5, f) → "5 лидов"    plural("en", 3, f) → "3 leads"
 */
export function plural(locale: Locale, count: number, forms: PluralForms): string {
  return forms[pluralCategory(locale, count)];
}

/**
 * Error and warning codes shared with the server actions, the pipeline and the
 * outreach layer. The accepted list is derived from the dictionary itself, so
 * adding a string to `en.errors` immediately makes that code valid everywhere.
 */
export type ErrorCode = keyof Dictionary["errors"];
const ERROR_CODES = new Set<string>(Object.keys(en.errors));

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value);
}

/**
 * Renders a code carried by an action redirect. Anything unrecognised degrades
 * to a generic message instead of leaking a raw code — or, worse, the English
 * sentence we used to put in the URL — into the UI.
 */
export function errorText(
  t: Dictionary,
  value: string | null | undefined,
  params: Record<string, string | number> = {},
): string | null {
  if (!value) return null;
  return template(t.errors[isErrorCode(value) ? value : "unknown"], params);
}

export type DuplicateReason = keyof Dictionary["lead"]["duplicateReasons"];
const DUPLICATE_REASONS = new Set<string>(Object.keys(en.lead.duplicateReasons));

/** Why a lead was treated as a duplicate, in the owner's language. */
export function duplicateReasonText(
  t: Dictionary,
  code: string | null,
  percent?: number | null,
): string | null {
  if (!code || !DUPLICATE_REASONS.has(code)) return null;
  return template(t.lead.duplicateReasons[code as DuplicateReason], { percent: percent ?? 0 });
}

/** The bit of `LeadEvent.metadata` a deduplicated sighting always carries. */
function readReasonMetadata(
  metadata: unknown,
): { code: string; percent: number | null } | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const record = metadata as Record<string, unknown>;
  const code = record.reason;
  if (typeof code !== "string" || !DUPLICATE_REASONS.has(code)) return null;
  const percent = typeof record.percent === "number" ? record.percent : null;
  return { code, percent };
}

/**
 * Renders one activity-trail line.
 *
 * `LeadEvent.message` is prose written at the moment the event happened (in
 * English) and is normally shown verbatim — it is a log line, not UI copy. The
 * single exception is a deduplicated sighting: that row also stores the machine
 * readable `reason` code, so the trail can be re-rendered in the owner's language
 * from exactly the data the duplicate banner above it uses. Junk metadata falls
 * back to the stored prose rather than dropping the line.
 */
export function eventMessageText(
  t: Dictionary,
  event: { message: string; metadata?: unknown },
): string {
  const metadata = readReasonMetadata(event.metadata);
  if (!metadata) return event.message;
  const reason = duplicateReasonText(t, metadata.code, metadata.percent);
  if (!reason) return event.message;
  return template(t.lead.duplicateEvent, { reason });
}
