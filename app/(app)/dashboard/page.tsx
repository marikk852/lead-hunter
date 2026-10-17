import Link from "next/link";
import { getDashboardStats, getDueFollowUps, listLeads } from "@/src/leads/queries";
import {
  Empty,
  ScoreBadge,
  Section,
  StatTile,
  TemperaturePill,
  formatBudget,
  formatDate,
  relativeAge,
} from "@/src/components/ui";
import { getI18n } from "@/src/i18n";
import { prisma } from "@/src/lib/db";

const STATUS_WEIGHT: Record<string, number> = { NEW: 0, REVIEWED: 1 };

export default async function DashboardPage() {
  const { locale, t } = await getI18n();

  const [stats, topLeads, dueFollowUps, providerInfo] = await Promise.all([
    getDashboardStats(),
    // Open opportunities: freshly discovered or reviewed but not yet contacted.
    listLeads({ statuses: ["NEW", "REVIEWED"], pageSize: 6 }),
    getDueFollowUps(),
    prisma.aIAnalysis.findFirst({
      orderBy: { createdAt: "desc" },
      select: { provider: true, model: true, createdAt: true, usage: true },
    }),
  ]);

  const now = new Date();
  const revenue =
    stats.potentialRevenueMin > 0 || stats.potentialRevenueMax > 0
      ? formatBudget(
          stats.potentialRevenueMin || null,
          stats.potentialRevenueMax || null,
          stats.currency,
          locale,
        )
      : t.common.notSet;

  const sorted = [...topLeads.leads].sort(
    (a, b) =>
      (STATUS_WEIGHT[a.status] ?? 9) - (STATUS_WEIGHT[b.status] ?? 9) ||
      b.leadScore - a.leadScore,
  );

  return (
    <div className="space-y-6 rise">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label">{t.dashboard.kicker}</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink-50">
            {t.dashboard.heading}
          </h1>
        </div>
        <p className="text-xs text-ink-400">
          <span className="num">{stats.newToday}</span> {t.dashboard.discoveredToday} ·{" "}
          <span className="num">{stats.needsReview}</span> {t.dashboard.awaitingReview}
          {stats.failed > 0 ? (
            <span className="text-hot">
              {" · "}
              <span className="num">{stats.failed}</span>{" "}
              {stats.failed === 1 ? t.dashboard.failedOne : t.dashboard.failedMany}
            </span>
          ) : null}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label={t.dashboard.tiles.hot}
          value={stats.hot}
          tone="hot"
          hint={t.dashboard.tiles.hotHint}
        />
        <StatTile
          label={t.dashboard.tiles.warm}
          value={stats.warm}
          tone="warm"
          hint={t.dashboard.tiles.warmHint}
        />
        <StatTile
          label={t.dashboard.tiles.cold}
          value={stats.cold}
          tone="cold"
          hint={t.dashboard.tiles.coldHint}
        />
        <StatTile label={t.dashboard.tiles.contacted} value={stats.contacted} />
        <StatTile label={t.dashboard.tiles.replied} value={stats.replied} tone="good" />
        <StatTile label={t.dashboard.tiles.won} value={stats.won} tone="good" />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <StatTile
          label={t.dashboard.tiles.pipelineValue}
          value={revenue}
          hint={t.dashboard.tiles.pipelineHint}
        />
        <StatTile
          label={t.dashboard.tiles.qualified}
          value={stats.qualified}
          hint={t.dashboard.tiles.qualifiedHint}
        />
        <StatTile
          label={t.dashboard.tiles.engine}
          value={
            providerInfo
              ? providerInfo.provider === "heuristic"
                ? t.nav.providerRules
                : providerInfo.provider
              : t.common.notSet
          }
          hint={
            providerInfo
              ? relativeAge(providerInfo.createdAt, locale, now)
              : t.dashboard.tiles.engineHintEmpty
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Section
          title={t.dashboard.newLeads}
          className="lg:col-span-2"
          action={
            <Link href="/leads" className="text-xs text-ink-400 hover:text-ink-50">
              {t.dashboard.allLeads}
            </Link>
          }
        >
          {sorted.length === 0 ? (
            <Empty>
              {t.dashboard.empty}{" "}
              <Link href="/leads/new" className="text-hot hover:underline">
                {t.dashboard.emptyCta}
              </Link>{" "}
              {t.dashboard.emptyAfter}
            </Empty>
          ) : (
            <ul className="divide-y divide-ink-800">
              {sorted.map((lead) => (
                <li key={lead.id}>
                  <Link
                    href={`/leads/${lead.id}`}
                    className="-mx-2 flex items-center gap-4 px-2 py-3 transition-colors hover:bg-ink-850"
                  >
                    <ScoreBadge
                      score={lead.leadScore}
                      temperature={lead.temperature}
                      scoreLabel={t.lead.leadScore}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink-50">
                        {lead.projectDescription ?? lead.title ?? lead.originalContent}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-ink-400">
                        {t.enums.categories[lead.category].toLowerCase()}
                        {lead.location ? ` · ${lead.location}` : ""}
                        {lead.businessType ? ` · ${lead.businessType}` : ""}
                        {" · "}
                        {relativeAge(lead.createdAt, locale, now)}
                      </p>
                    </div>
                    <span className="num hidden text-xs text-ink-300 sm:block">
                      {formatBudget(lead.budgetMin, lead.budgetMax, lead.budgetCurrency, locale)}
                    </span>
                    <TemperaturePill
                      temperature={lead.temperature}
                      label={t.enums.temperatures[lead.temperature]}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="space-y-4">
          <Section title={t.dashboard.followUpsDue}>
            {dueFollowUps.length === 0 ? (
              <Empty>{t.dashboard.nothingToChase}</Empty>
            ) : (
              <ul className="space-y-3">
                {dueFollowUps.map((followUp) => (
                  <li key={followUp.id}>
                    <Link
                      href={`/leads/${followUp.lead.id}`}
                      className="block text-sm text-ink-100 hover:text-hot"
                    >
                      {followUp.lead.title ?? t.nav.leads}
                    </Link>
                    <p className="num mt-0.5 text-xs text-hot">
                      {t.lead.due} {formatDate(followUp.dueAt, locale)} (
                      {relativeAge(followUp.dueAt, locale, now)})
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={t.dashboard.rulesTitle}>
            <ul className="space-y-2 text-xs leading-relaxed text-ink-400">
              {t.dashboard.rules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
