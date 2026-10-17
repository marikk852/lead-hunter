import Link from "next/link";
import { DEFAULT_PAGE_SIZE, getFilterOptions, listLeads } from "@/src/leads/queries";
import {
  Empty,
  ScoreBadge,
  TemperaturePill,
  formatBudget,
  relativeAge,
} from "@/src/components/ui";
import { LeadCategory, LeadStatus, SourceKind, Temperature, Urgency } from "@/src/generated/prisma/enums";
import { getI18n, plural } from "@/src/i18n";

type SearchParams = Record<string, string | string[] | undefined>;

function single(params: SearchParams, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

function num(params: SearchParams, key: string): number | undefined {
  const raw = single(params, key);
  if (raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asEnum<T extends string>(raw: string, values: readonly T[]): T | undefined {
  return (values as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { locale, t } = await getI18n();

  const filters = {
    q: single(params, "q") || undefined,
    sourceKind: asEnum(single(params, "sourceKind"), Object.values(SourceKind)),
    category: asEnum(single(params, "category"), Object.values(LeadCategory)),
    temperature: asEnum(single(params, "temperature"), Object.values(Temperature)),
    status: asEnum(single(params, "status"), Object.values(LeadStatus)),
    urgency: asEnum(single(params, "urgency"), Object.values(Urgency)),
    minScore: num(params, "minScore"),
    minBudget: num(params, "minBudget"),
    location: single(params, "location") || undefined,
    page: num(params, "page") ?? 1,
    pageSize: DEFAULT_PAGE_SIZE,
  };

  const [{ leads, total, pageCount, page }, options] = await Promise.all([
    listLeads(filters),
    getFilterOptions(),
  ]);

  const now = new Date();
  const query = (next: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, ...next })) {
      const entry = typeof value === "string" ? value : value === undefined ? "" : String(value);
      if (entry !== "") search.set(key, entry);
    }
    return `/leads?${search.toString()}`;
  };

  const activeFilterCount = [
    filters.q,
    filters.sourceKind,
    filters.category,
    filters.temperature,
    filters.status,
    filters.urgency,
    filters.minScore,
    filters.minBudget,
    filters.location,
  ].filter((value) => value !== undefined).length;

  return (
    <div className="space-y-5 rise">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label">{t.leads.kicker}</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink-50">
            <span className="num">{total}</span>{" "}
            {plural(locale, total, {
              one: t.leads.countOne,
              few: t.leads.countFew,
              many: t.leads.countMany,
            })}
            {activeFilterCount > 0 ? (
              <span className="ml-2 text-sm font-normal text-ink-400">
                <span className="num">{activeFilterCount}</span>{" "}
                {plural(locale, activeFilterCount, {
                  one: t.leads.filtersActiveOne,
                  few: t.leads.filtersActiveFew,
                  many: t.leads.filtersActiveMany,
                })}
              </span>
            ) : null}
          </h1>
        </div>
        <Link
          href="/leads/new"
          className="border border-hot bg-hot px-3 py-1.5 text-xs font-semibold text-ink-950 transition-colors hover:border-ink-50 hover:bg-ink-50"
        >
          {t.leads.addLead}
        </Link>
      </header>

      <form method="GET" action="/leads" className="panel grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <label htmlFor="q" className="label block">
            {t.leads.search}
          </label>
          <input
            id="q"
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder={t.leads.searchPlaceholder}
            className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50 placeholder:text-ink-600"
          />
        </div>

        <div>
          <label htmlFor="status" className="label block">
            {t.leads.filters.status}
          </label>
          <select
            id="status"
            name="status"
            defaultValue={filters.status ?? ""}
            className="mt-1 w-full border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100"
          >
            <option value="">{t.common.any}</option>
            {Object.values(LeadStatus).map((value) => (
              <option key={value} value={value}>
                {t.enums.statuses[value]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="temperature" className="label block">
            {t.leads.filters.temperature}
          </label>
          <select
            id="temperature"
            name="temperature"
            defaultValue={filters.temperature ?? ""}
            className="mt-1 w-full border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100"
          >
            <option value="">{t.common.any}</option>
            {Object.values(Temperature).map((value) => (
              <option key={value} value={value}>
                {t.enums.temperatures[value]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="category" className="label block">
            {t.leads.filters.category}
          </label>
          <select
            id="category"
            name="category"
            defaultValue={filters.category ?? ""}
            className="mt-1 w-full border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100"
          >
            <option value="">{t.common.any}</option>
            {(options.categories.length > 0 ? options.categories : Object.values(LeadCategory)).map(
              (value) => (
                <option key={value} value={value}>
                  {t.enums.categories[value]}
                </option>
              ),
            )}
          </select>
        </div>

        <div>
          <label htmlFor="sourceKind" className="label block">
            {t.leads.filters.source}
          </label>
          <select
            id="sourceKind"
            name="sourceKind"
            defaultValue={filters.sourceKind ?? ""}
            className="mt-1 w-full border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100"
          >
            <option value="">{t.common.any}</option>
            {Object.values(SourceKind).map((value) => (
              <option key={value} value={value}>
                {t.enums.sourceKinds[value]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="urgency" className="label block">
            {t.leads.filters.urgency}
          </label>
          <select
            id="urgency"
            name="urgency"
            defaultValue={filters.urgency ?? ""}
            className="mt-1 w-full border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100"
          >
            <option value="">{t.common.any}</option>
            {Object.values(Urgency).map((value) => (
              <option key={value} value={value}>
                {t.enums.urgencies[value]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="minScore" className="label block">
            {t.leads.filters.minScore}
          </label>
          <input
            id="minScore"
            name="minScore"
            type="number"
            min={0}
            max={100}
            defaultValue={filters.minScore ?? ""}
            placeholder="80"
            className="num mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
          />
        </div>

        <div>
          <label htmlFor="minBudget" className="label block">
            {t.leads.filters.minBudget}
          </label>
          <input
            id="minBudget"
            name="minBudget"
            type="number"
            min={0}
            defaultValue={filters.minBudget ?? ""}
            placeholder="1000"
            className="num mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
          />
        </div>

        <div>
          <label htmlFor="location" className="label block">
            {t.leads.filters.location}
          </label>
          <input
            id="location"
            name="location"
            defaultValue={filters.location ?? ""}
            placeholder={t.leads.filters.locationPlaceholder}
            list="location-options"
            className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
          />
          <datalist id="location-options">
            {options.locations.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </div>

        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="border border-ink-600 px-3 py-1.5 text-xs font-semibold text-ink-100 transition-colors hover:border-ink-400 hover:text-ink-50"
          >
            {t.common.apply}
          </button>
          {activeFilterCount > 0 ? (
            <Link
              href="/leads"
              className="px-3 py-1.5 text-xs text-ink-400 transition-colors hover:text-ink-50"
            >
              {t.common.reset}
            </Link>
          ) : null}
        </div>
      </form>

      <div className="panel overflow-hidden">
        {leads.length === 0 ? (
          <Empty>{t.leads.empty}</Empty>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="hairline text-left">
                <th className="label px-4 py-2 font-normal">{t.leads.columns.score}</th>
                <th className="label px-3 py-2 font-normal">{t.leads.columns.project}</th>
                <th className="label hidden px-3 py-2 font-normal md:table-cell">
                  {t.leads.columns.budget}
                </th>
                <th className="label hidden px-3 py-2 font-normal lg:table-cell">
                  {t.leads.columns.source}
                </th>
                <th className="label hidden px-3 py-2 font-normal sm:table-cell">
                  {t.leads.columns.status}
                </th>
                <th className="label px-3 py-2 text-right font-normal">{t.leads.columns.age}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {leads.map((lead) => (
                <tr key={lead.id} className="transition-colors hover:bg-ink-850">
                  <td className="px-4 py-2.5 align-top">
                    <Link href={`/leads/${lead.id}`} className="block">
                      <ScoreBadge
                        score={lead.leadScore}
                        temperature={lead.temperature}
                        scoreLabel={t.lead.leadScore}
                      />
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 align-top">
                    <Link href={`/leads/${lead.id}`} className="block">
                      <span className="line-clamp-1 text-ink-50">
                        {lead.projectDescription ?? lead.title ?? lead.originalContent.slice(0, 90)}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-400">
                        {t.enums.categories[lead.category].toLowerCase()}
                        {lead.businessType ? ` · ${lead.businessType}` : ""}
                        {lead.location ? ` · ${lead.location}` : ""}
                        {lead.analysisStatus === "FAILED" ? (
                          <span className="text-hot"> · {t.leads.analysisFailed}</span>
                        ) : null}
                      </span>
                    </Link>
                  </td>
                  <td className="num hidden px-3 py-2.5 align-top text-xs text-ink-300 md:table-cell">
                    {formatBudget(lead.budgetMin, lead.budgetMax, lead.budgetCurrency, locale)}
                  </td>
                  <td className="hidden px-3 py-2.5 align-top text-xs text-ink-400 lg:table-cell">
                    {t.enums.sourceKinds[lead.source.kind]}
                  </td>
                  <td className="hidden px-3 py-2.5 align-top sm:table-cell">
                    <span className="num text-xs text-ink-300">
                      {t.enums.statuses[lead.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 align-top text-right">
                    <span className="num text-xs text-ink-400">
                      {relativeAge(lead.createdAt, locale, now)}
                    </span>
                    <span className="mt-1 block">
                      <TemperaturePill
                        temperature={lead.temperature}
                        label={t.enums.temperatures[lead.temperature]}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pageCount > 1 ? (
        <nav className="flex items-center justify-between text-xs text-ink-400">
          {page > 1 ? (
            <Link href={query({ page: page - 1 })} className="hover:text-ink-50">
              {t.leads.previous}
            </Link>
          ) : (
            <span />
          )}
          <span className="num">
            {t.leads.page} <span className="num">{page}</span> /{" "}
            <span className="num">{pageCount}</span>
          </span>
          {page < pageCount ? (
            <Link href={query({ page: page + 1 })} className="hover:text-ink-50">
              {t.leads.next}
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
