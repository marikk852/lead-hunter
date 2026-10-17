import {
  addSearchQueryAction,
  deleteSearchQueryAction,
  saveAiKeysAction,
  saveProfileAction,
  toggleSearchQueryAction,
} from "@/app/(app)/settings/actions";
import { SubmitButton } from "@/src/components/client-buttons";
import { Section } from "@/src/components/ui";
import { callsUsedToday, describeAIProvider } from "@/src/ai";
import { SourceKind } from "@/src/generated/prisma/enums";
import { errorText, getI18n, template } from "@/src/i18n";
import { prisma } from "@/src/lib/db";
import { hasCompatKey, hasOwnAnthropicKey } from "@/src/lib/env";
import { DEFAULT_PROFILE, getOwnerProfile, isProfileUnconfigured } from "@/src/profile";

const SUGGESTED_QUERIES = [
  "looking for a web developer",
  "need a website",
  "need a wordpress developer",
  "need a woocommerce developer",
  "need someone to build an app",
  "need a telegram bot",
  "website developer needed",
];

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { t } = await getI18n();
  const params = await searchParams;
  const [profile, queries, usedToday] = await Promise.all([
    getOwnerProfile(),
    prisma.searchQuery.findMany({ orderBy: { createdAt: "desc" } }),
    callsUsedToday(),
  ]);
  // The *resolved* provider and model — not the raw env strings, which would
  // claim "claude-opus-4-7" while the rules were actually scoring the leads.
  const provider = describeAIProvider();
  const dailyLimit = process.env.AI_DAILY_CALL_LIMIT ?? 250;
  // Only *whether* a key exists is rendered — never the stored value itself.
  const compatKeySet = hasCompatKey();
  const anthropicKeySet = hasOwnAnthropicKey();
  const error = errorText(t, typeof params.error === "string" ? params.error : null);

  return (
    <div className="space-y-5 rise">
      <header>
        <p className="label">{t.settings.kicker}</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink-50">
          {t.settings.heading}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-400">{t.settings.intro}</p>
      </header>

      {typeof params.saved === "string" ? (
        <p className="border-l-2 border-signal-green pl-3 text-sm text-signal-green">
          {t.settings.saved}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="border-l-2 border-hot pl-3 text-sm text-hot">
          {error}
        </p>
      ) : null}

      {isProfileUnconfigured(profile) ? (
        <p className="border-l-2 border-warm pl-3 text-sm text-warm">
          {t.settings.seedWarning}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <form action={saveProfileAction} className="panel space-y-4 p-4 lg:col-span-2">
          <h2 className="label">{t.settings.profileSection}</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="name" className="label block">
                {t.settings.name}
              </label>
              <input
                id="name"
                name="name"
                defaultValue={profile.name}
                className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
              />
            </div>
            <div>
              <label htmlFor="location" className="label block">
                {t.settings.location}
              </label>
              <input
                id="location"
                name="location"
                defaultValue={profile.location ?? ""}
                className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="services" className="label block">
                {t.settings.services}
              </label>
              <input
                id="services"
                name="services"
                defaultValue={profile.services.join(", ")}
                className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="languages" className="label block">
                {t.settings.languages}
              </label>
              <input
                id="languages"
                name="languages"
                defaultValue={profile.languages.join(", ")}
                className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="experience" className="label block">
                {t.settings.experience}
              </label>
              <input
                id="experience"
                name="experience"
                defaultValue={profile.experience ?? ""}
                className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
              />
            </div>
            <div>
              <label htmlFor="minimumBudget" className="label block">
                {t.settings.minimumBudget}
              </label>
              <input
                id="minimumBudget"
                name="minimumBudget"
                type="number"
                min={0}
                defaultValue={profile.minimumBudget ?? ""}
                className="num mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
              />
            </div>
            <div>
              <label htmlFor="tone" className="label block">
                {t.settings.tone}
              </label>
              <input
                id="tone"
                name="tone"
                defaultValue={profile.tone ?? ""}
                placeholder={t.settings.tonePlaceholder}
                className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="portfolio" className="label block">
                {t.settings.portfolio}
              </label>
              <textarea
                id="portfolio"
                name="portfolio"
                rows={4}
                defaultValue={profile.portfolio
                  .map((item) => [item.title, item.url, item.description].filter(Boolean).join(" | "))
                  .join("\n")}
                className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-2 text-sm text-ink-50"
              />
            </div>
          </div>

          <SubmitButton pendingLabel={t.common.saving}>{t.settings.saveProfile}</SubmitButton>

          <p className="text-xs text-ink-500">
            {t.settings.seededDefaults} {DEFAULT_PROFILE.services.join(", ")}
          </p>
        </form>

        <div className="space-y-4">
          <Section title={t.settings.aiProvider}>
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-400">{t.settings.active}</dt>
                <dd className="num text-ink-50">{provider.name}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-400">{t.settings.model}</dt>
                <dd className="num text-ink-50">{provider.model}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-400">{t.settings.billableCalls}</dt>
                <dd className="num text-ink-50">
                  {usedToday}/{dailyLimit}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-ink-500">
              {/* The reason is a code, so the sentence reads in either language. */}
              {template(t.settings.providerActive, {
                reason: template(t.settings.providerReasons[provider.reason], {
                  key: provider.expectedKey ?? "",
                }),
              })}{" "}
              {provider.keyed ? null : t.settings.providerSetup}
            </p>

            <form
              action={saveAiKeysAction}
              className="mt-4 space-y-3 border-t border-ink-800 pt-4"
            >
              <p className="label">{t.settings.apiKeys}</p>

              <div>
                <label htmlFor="aiApiKey" className="label block">
                  {t.settings.compatKeyLabel}
                </label>
                <input
                  id="aiApiKey"
                  name="aiApiKey"
                  type="password"
                  autoComplete="new-password"
                  placeholder={compatKeySet ? t.settings.keySet : t.settings.keyNotSet}
                  className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50 placeholder:text-ink-600"
                />
                <label className="mt-1 flex items-center gap-2 text-xs text-ink-400">
                  <input type="checkbox" name="clearAiApiKey" className="size-3 accent-hot" />
                  {t.settings.clearKey}
                </label>
              </div>

              <div>
                <label htmlFor="anthropicApiKey" className="label block">
                  {t.settings.anthropicKeyLabel}
                </label>
                <input
                  id="anthropicApiKey"
                  name="anthropicApiKey"
                  type="password"
                  autoComplete="new-password"
                  placeholder={anthropicKeySet ? t.settings.keySet : t.settings.keyNotSet}
                  className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50 placeholder:text-ink-600"
                />
                <label className="mt-1 flex items-center gap-2 text-xs text-ink-400">
                  <input
                    type="checkbox"
                    name="clearAnthropicApiKey"
                    className="size-3 accent-hot"
                  />
                  {t.settings.clearKey}
                </label>
              </div>

              <SubmitButton pendingLabel={t.common.saving}>
                {t.settings.saveKeys}
              </SubmitButton>
              <p className="text-xs leading-relaxed text-ink-500">
                {t.settings.keysHint}
              </p>
            </form>
          </Section>

          <Section title={t.settings.savedQueries}>
            <form action={addSearchQueryAction} className="space-y-2">
              <input
                name="query"
                placeholder={t.settings.queryPlaceholder}
                className="w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50 placeholder:text-ink-600"
              />
              <div className="flex items-center gap-2">
                <select
                  name="kind"
                  defaultValue={SourceKind.REDDIT}
                  className="border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100"
                >
                  {(
                    [
                      SourceKind.REDDIT,
                      SourceKind.TELEGRAM,
                      SourceKind.WEB,
                      SourceKind.X,
                      SourceKind.FORUM,
                      SourceKind.JOB_BOARD,
                    ] as const
                  ).map((kind) => (
                    <option key={kind} value={kind}>
                      {t.enums.sourceKinds[kind]}
                    </option>
                  ))}
                </select>
                <SubmitButton variant="quiet" pendingLabel={t.settings.adding}>
                  {t.common.add}
                </SubmitButton>
              </div>
            </form>

            <ul className="mt-4 divide-y divide-ink-800">
              {queries.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-2 py-2">
                  <span
                    className={`text-sm ${entry.enabled ? "text-ink-100" : "text-ink-600 line-through"}`}
                  >
                    {entry.query}
                  </span>
                  <span className="flex items-center gap-1">
                    <form action={toggleSearchQueryAction}>
                      <input type="hidden" name="queryId" value={entry.id} />
                      <button
                        type="submit"
                        className="px-2 py-1 text-xs text-ink-400 transition-colors hover:text-ink-50"
                      >
                        {entry.enabled ? t.common.disable : t.common.enable}
                      </button>
                    </form>
                    <form action={deleteSearchQueryAction}>
                      <input type="hidden" name="queryId" value={entry.id} />
                      <button
                        type="submit"
                        className="px-2 py-1 text-xs text-ink-600 transition-colors hover:text-hot"
                      >
                        {t.common.delete}
                      </button>
                    </form>
                  </span>
                </li>
              ))}
              {queries.length === 0 ? (
                <li className="py-2 text-xs text-ink-500">{t.settings.noQueries}</li>
              ) : null}
            </ul>

            <details className="mt-4">
              <summary className="label cursor-pointer">{t.settings.starterQueries}</summary>
              <ul className="mt-2 space-y-1 text-xs text-ink-400">
                {SUGGESTED_QUERIES.map((query) => (
                  <li key={query} className="num">
                    {query}
                  </li>
                ))}
              </ul>
            </details>
          </Section>
        </div>
      </div>
    </div>
  );
}
