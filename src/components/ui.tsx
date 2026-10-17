/**
 * Presentational primitives shared by the console screens.
 * Server components unless marked otherwise — the console ships almost no JS.
 *
 * Formatting goes through `Intl`, so numbers, dates and relative times follow the
 * selected locale without a table of strings in the dictionary.
 */
import type { ReactNode } from "react";
import { Temperature } from "@/src/generated/prisma/enums";
import type { Locale } from "@/src/i18n/config";

const TEMPERATURE_CLASS: Record<Temperature, string> = {
  HOT: "text-hot border-hot",
  WARM: "text-warm border-warm",
  COLD: "text-cold border-cold",
};

export const TEMPERATURE_GLYPH: Record<Temperature, string> = {
  HOT: "▲",
  WARM: "◆",
  COLD: "▽",
};

export function TemperaturePill({
  temperature,
  label,
  className = "",
}: {
  temperature: Temperature;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={`num inline-flex items-center gap-1 border px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider ${TEMPERATURE_CLASS[temperature]} ${className}`}
    >
      <span aria-hidden>{TEMPERATURE_GLYPH[temperature]}</span>
      {label}
    </span>
  );
}

export function ScoreBadge({
  score,
  temperature,
  scoreLabel,
  size = "md",
}: {
  score: number;
  temperature: Temperature;
  /** Tooltip text, e.g. "Lead score". */
  scoreLabel: string;
  size?: "md" | "lg";
}) {
  const tone =
    temperature === Temperature.HOT
      ? "text-hot"
      : temperature === Temperature.WARM
        ? "text-warm"
        : "text-cold";
  return (
    <span
      className={`num font-semibold ${tone} ${size === "lg" ? "text-4xl" : "text-lg"}`}
      title={`${scoreLabel} ${score}/100`}
    >
      {score}
      <span className="text-ink-600">/100</span>
    </span>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "hot" | "warm" | "cold" | "default" | "good";
}) {
  const toneClass =
    tone === "hot"
      ? "text-hot"
      : tone === "warm"
        ? "text-warm"
        : tone === "cold"
          ? "text-cold"
          : tone === "good"
            ? "text-signal-green"
            : "text-ink-50";

  return (
    <div className="panel px-4 py-3">
      <p className="label">{label}</p>
      <p className={`num mt-2 text-2xl font-semibold ${toneClass}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-ink-400">{hint}</p> : null}
    </div>
  );
}

export function Section({
  title,
  action,
  children,
  className = "",
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="hairline flex items-center justify-between gap-3 px-4 py-2.5">
        <h2 className="label">{title}</h2>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-ink-400">{children}</p>;
}

export function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    // min-w-0 lets the value wrap instead of pushing its grid track wider.
    <div className="min-w-0">
      <p className="label">{label}</p>
      <p className={`mt-1 text-sm break-words text-ink-100 ${mono ? "num" : ""}`}>
        {value ?? <span className="text-ink-600">—</span>}
      </p>
    </div>
  );
}

/** Currency shown as an ISO code, which needs no translation. */
export function formatBudget(
  min: number | null,
  max: number | null,
  currency: string | null,
  locale: Locale,
): string {
  if (min === null && max === null) return "—";
  const formatter = new Intl.NumberFormat(locale);
  const money = (value: number) =>
    `${currency ? `${currency} ` : ""}${formatter.format(value)}`;
  if (min !== null && max !== null && min !== max) return `${money(min)}–${money(max)}`;
  return money((max ?? min) as number);
}

export function formatDate(value: Date | null | undefined, locale: Locale): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

/** "10m ago" / "10 мин. назад", produced by Intl rather than the dictionary. */
export function relativeAge(
  value: Date | null | undefined,
  locale: Locale,
  now = new Date(),
): string {
  if (!value) return "—";
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
  const minutes = Math.round((now.getTime() - value.getTime()) / 60_000);

  if (Math.abs(minutes) < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.round(hours / 24), "day");
}
