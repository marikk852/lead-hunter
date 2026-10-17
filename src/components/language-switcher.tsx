import { setLocaleAction } from "@/src/i18n/actions";
import { LOCALE_LABELS, LOCALE_NAMES, LOCALES, type Locale } from "@/src/i18n/config";

/**
 * Segmented language control. Plain form buttons, so it works without JavaScript
 * and needs no client component.
 */
export function LanguageSwitcher({
  current,
  label,
}: {
  current: Locale;
  label: string;
}) {
  return (
    <form action={setLocaleAction} aria-label={label} className="flex items-center">
      <span className="label mr-2 hidden sm:inline">{label}</span>
      <span className="flex border border-ink-800">
        {LOCALES.map((locale) => {
          const active = locale === current;
          return (
            <button
              key={locale}
              type="submit"
              name="locale"
              value={locale}
              aria-pressed={active}
              title={LOCALE_NAMES[locale]}
              className={`num px-2 py-1 text-xs transition-colors ${
                active
                  ? "bg-ink-100 text-ink-950"
                  : "text-ink-400 hover:bg-ink-850 hover:text-ink-50"
              }`}
            >
              {LOCALE_LABELS[locale]}
            </button>
          );
        })}
      </span>
    </form>
  );
}
