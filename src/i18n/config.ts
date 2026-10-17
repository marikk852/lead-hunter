/** Supported UI locales. Add a locale here, then add its dictionary. */
export const LOCALES = ["en", "ru"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Cookie that remembers the owner's choice. Read on the server, so no client state. */
export const LOCALE_COOKIE = "lh_locale";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "EN",
  ru: "RU",
};

/** Full names, used for the accessible label of the switcher. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  ru: "Русский",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}
