/**
 * Server-side i18n. The locale lives in a cookie, so every screen renders in the
 * right language on the first paint with no client-side state to hydrate.
 */
import { cache } from "react";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "@/src/i18n/config";
import { en, type Dictionary } from "@/src/i18n/en";
import { ru } from "@/src/i18n/ru";

export { LOCALES, LOCALE_LABELS, LOCALE_NAMES, DEFAULT_LOCALE, isLocale } from "@/src/i18n/config";
export type { Locale } from "@/src/i18n/config";
export type { Dictionary } from "@/src/i18n/en";
export {
  duplicateReasonText,
  errorText,
  eventMessageText,
  isErrorCode,
  plural,
  template,
  type DuplicateReason,
  type ErrorCode,
} from "@/src/i18n/text";

const DICTIONARIES: Record<Locale, Dictionary> = { en, ru };

/** Cached per request, so reading the cookie once serves every component. */
export const getLocale = cache(async (): Promise<Locale> => {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
});

export const getDictionary = cache(async (): Promise<Dictionary> => {
  return DICTIONARIES[await getLocale()];
});

/**
 * Locale + dictionary in one call — the usual entry point for a screen.
 *
 *   const { locale, t } = await getI18n();
 */
export async function getI18n(): Promise<{ locale: Locale; t: Dictionary }> {
  const locale = await getLocale();
  return { locale, t: DICTIONARIES[locale] };
}

/** Every dictionary, for tests and for tooling that checks key parity. */
export const dictionaries = DICTIONARIES;
