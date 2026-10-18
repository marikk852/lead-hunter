import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addNoteAction,
  changeStatusAction,
  completeFollowUpAction,
  generateResponseAction,
  markContactedAction,
  reanalyzeAction,
  recordOutcomeAction,
  saveDraftAction,
} from "@/app/(app)/leads/actions";
import { CopyButton, SubmitButton } from "@/src/components/client-buttons";
import {
  Field,
  ScoreBadge,
  Section,
  TemperaturePill,
  formatBudget,
  formatDate,
} from "@/src/components/ui";
import { LeadStatus, OutreachStatus } from "@/src/generated/prisma/enums";
import { duplicateReasonText, errorText, eventMessageText, getI18n } from "@/src/i18n";
import { readStoredAnalysis } from "@/src/leads/outreach";
import { getLeadDetail } from "@/src/leads/queries";
import { readNumberParam, readParam } from "@/src/lib/params";

type ScoreComponent = { factor: string; normalized: number; weight: number; points: number };

function parseBreakdown(value: unknown): {
  components: ScoreComponent[];
  confidence: number | null;
  recommendedService: string | null;
  notes: string[];
} {
  const empty = { components: [], confidence: null, recommendedService: null, notes: [] as string[] };
  if (typeof value !== "object" || value === null) return empty;
  const record = value as Record<string, unknown>;

  const components = Array.isArray(record.components)
    ? record.components.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const item = entry as Record<string, unknown>;
        if (typeof item.factor !== "string") return [];
        return [
          {
            factor: item.factor,
            normalized: typeof item.normalized === "number" ? item.normalized : 0,
            weight: typeof item.weight === "number" ? item.weight : 0,
            points: typeof item.points === "number" ? item.points : 0,
          },
        ];
      })
    : [];

  return {
    components,
    confidence: typeof record.confidence === "number" ? record.confidence : null,
    recommendedService:
      typeof record.recommendedService === "string" ? record.recommendedService : null,
    notes: Array.isArray(record.notes)
      ? record.notes.flatMap((note) => (typeof note === "string" ? [note] : []))
      : [],
  };
}

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { locale, t } = await getI18n();

  const lead = await getLeadDetail(id);
  if (!lead) notFound();

  const dailyLimit = process.env.AI_DAILY_CALL_LIMIT ?? 250;
  const warning = errorText(t, readParam(query, "warning"), { limit: dailyLimit });
  const duplicateNote = duplicateReasonText(
    t,
    readParam(query, "duplicate"),
    readNumberParam(query, "percent"),
  );

  const analysis = readStoredAnalysis(lead.aiAnalysis);
  const breakdown = parseBreakdown(lead.scoreBreakdown);
  const draft = lead.outreach.find((entry) => entry.status !== OutreachStatus.DISCARDED) ?? null;
  const nextFollowUp = lead.followUps.find((entry) => !entry.done) ?? null;

  const factorLabel = (factor: string): string =>
    t.enums.scoreFactors[factor as keyof typeof t.enums.scoreFactors] ?? factor;

  return (
    <div className="space-y-5 rise">
      <div>
        <Link href="/leads" className="text-xs text-ink-400 hover:text-ink-50">
          {t.lead.back}
        </Link>
      </div>

      {warning ? (
        <p role="alert" className="border-l-2 border-hot pl-3 text-sm text-hot">
          {warning}
        </p>
      ) : null}
      {duplicateNote ? (
        <p className="border-l-2 border-warm pl-3 text-sm text-warm">
          {t.lead.duplicateBanner} ({duplicateNote}) {t.lead.duplicateBannerAfter}
        </p>
      ) : null}

      <header className="panel grid gap-x-8 gap-y-5 p-5 lg:grid-cols-[15rem_1fr]">
        <div>
          <p className="label">{t.lead.leadScore}</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <ScoreBadge
              score={lead.leadScore}
              temperature={lead.temperature}
              scoreLabel={t.lead.leadScore}
              size="lg"
            />
            <TemperaturePill
              temperature={lead.temperature}
              label={t.enums.temperatures[lead.temperature]}
            />
          </div>
          <p className="mt-1 text-xs text-ink-400">
            {t.lead.intent} <span className="num">{lead.intentScore}</span>/100
            {breakdown.confidence !== null
              ? ` · ${t.lead.confidence} ${breakdown.confidence.toFixed(2)}`
              : ""}
          </p>
        </div>

        <div className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-4">
          <Field
            label={t.lead.fields.status}
            value={<span className="num">{t.enums.statuses[lead.status]}</span>}
          />
          <Field
            label={t.lead.fields.category}
            value={t.enums.categories[lead.category].toLowerCase()}
            mono
          />
          <Field
            label={t.lead.fields.budget}
            value={formatBudget(lead.budgetMin, lead.budgetMax, lead.budgetCurrency, locale)}
            mono
          />
          <Field label={t.lead.fields.urgency} value={t.enums.urgencies[lead.urgency]} mono />
          <Field label={t.lead.fields.source} value={t.enums.sourceKinds[lead.source.kind]} mono />
          <Field label={t.lead.fields.query} value={lead.searchQuery?.query ?? null} />
          <Field label={t.lead.fields.author} value={lead.sourceAuthor} mono />
          <Field label={t.lead.fields.location} value={lead.location} />
          <Field label={t.lead.fields.business} value={lead.businessType} />
          <Field label={t.lead.fields.discovered} value={formatDate(lead.createdAt, locale)} mono />
          <Field label={t.lead.fields.posted} value={formatDate(lead.sourceCreatedAt, locale)} mono />
          <Field
            label={t.lead.fields.model}
            value={lead.aiModel ? <span className="text-xs break-all">{lead.aiModel}</span> : null}
            mono
          />
          <Field
            label={t.lead.fields.analysed}
            value={formatDate(lead.aiProcessedAt, locale)}
            mono
          />
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {lead.sourceUrl ? (
          <a
            href={lead.sourceUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="border border-ink-700 px-3 py-1.5 text-xs font-semibold text-ink-100 transition-colors hover:border-ink-400 hover:text-ink-50"
          >
            {t.lead.openSource} ↗
          </a>
        ) : null}

        <form action={generateResponseAction} className="flex items-end gap-2">
          <input type="hidden" name="leadId" value={lead.id} />
          <div>
            <label htmlFor="adjust" className="label block">
              {t.lead.revisionLabel}
            </label>
            <input
              id="adjust"
              name="adjust"
              placeholder={t.lead.revisionPlaceholder}
              className="mt-1 w-64 border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50 placeholder:text-ink-600"
            />
          </div>
          <SubmitButton pendingLabel={t.lead.drafting}>
            {draft ? t.lead.draftAnother : t.lead.generate}
          </SubmitButton>
        </form>

        <form action={reanalyzeAction}>
          <input type="hidden" name="leadId" value={lead.id} />
          <SubmitButton variant="quiet" pendingLabel={t.lead.reanalyzing}>
            {t.lead.reanalyze}
          </SubmitButton>
        </form>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Section title={t.lead.sections.original}>
            {lead.title ? (
              <p className="mb-2 text-sm font-semibold text-ink-50">{lead.title}</p>
            ) : null}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-100">
              {lead.originalContent}
            </p>
          </Section>

          <Section title={t.lead.sections.analysis}>
            {analysis ? (
              <div className="space-y-4">
                <p className="text-sm leading-relaxed text-ink-100">
                  {analysis.projectDescription || t.lead.noProject}
                </p>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t.lead.recommendedService} value={breakdown.recommendedService} />
                  <Field
                    label={t.lead.intentLabel}
                    value={`${lead.intentScore}/100`}
                    mono
                  />
                </div>

                {analysis.requirements.length > 0 ? (
                  <div>
                    <p className="label">{t.lead.requirements}</p>
                    <ul className="mt-1 space-y-1 text-sm text-ink-100">
                      {analysis.requirements.map((item) => (
                        <li key={item} className="border-l border-ink-700 pl-2">
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {analysis.painPoints.length > 0 ? (
                  <div>
                    <p className="label">{t.lead.painPoints}</p>
                    <ul className="mt-1 space-y-1 text-sm text-ink-100">
                      {analysis.painPoints.map((item) => (
                        <li key={item} className="border-l border-ink-700 pl-2">
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div>
                  <p className="label">{t.lead.reasoning}</p>
                  <p className="mt-1 text-sm leading-relaxed text-ink-300">{analysis.reasoning}</p>
                </div>

                {breakdown.components.length > 0 ? (
                  <div>
                    <p className="label">{t.lead.breakdown}</p>
                    <ul className="mt-2 space-y-1.5">
                      {breakdown.components.map((component) => (
                        <li key={component.factor} className="flex items-center gap-3">
                          <span className="w-28 text-xs text-ink-400">
                            {factorLabel(component.factor)}
                          </span>
                          <span
                            className="h-1.5 flex-1 bg-ink-800"
                            role="presentation"
                            aria-hidden
                          >
                            <span
                              className="block h-full bg-ink-400"
                              style={{ width: `${Math.round(component.normalized * 100)}%` }}
                            />
                          </span>
                          <span className="num w-16 text-right text-xs text-ink-300">
                            {component.points}/{component.weight}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {breakdown.notes.length > 0 ? (
                  <ul className="space-y-1 text-xs text-ink-500">
                    {breakdown.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-ink-400">
                {t.lead.noAnalysis}{" "}
                {lead.analysisStatus === "FAILED" ? t.lead.noAnalysisFailed : t.lead.noAnalysisIdle}
              </p>
            )}
          </Section>

          <Section
            title={t.lead.sections.response}
            action={
              draft ? (
                <div className="flex items-center gap-2">
                  <span className="label">{t.enums.outreachStatuses[draft.status]}</span>
                  <CopyButton text={draft.body} label={t.common.copyResponse} />
                </div>
              ) : null
            }
            className="scroll-mt-20"
          >
            <div id="draft" className="space-y-3">
              {draft ? (
                <>
                  <form action={saveDraftAction} className="space-y-3">
                    <input type="hidden" name="leadId" value={lead.id} />
                    <input type="hidden" name="outreachId" value={draft.id} />
                    <textarea
                      name="body"
                      rows={10}
                      defaultValue={draft.body}
                      className="w-full border border-ink-700 bg-ink-950 px-3 py-2 text-sm leading-relaxed text-ink-50"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <SubmitButton variant="quiet" pendingLabel={t.common.saving}>
                        {t.lead.saveEdits}
                      </SubmitButton>
                      <span className="text-xs text-ink-500">
                        {t.lead.draftedBy} <span className="num">{draft.model}</span>
                      </span>
                    </div>
                  </form>

                  <div className="flex flex-wrap items-center gap-2 border-t border-ink-800 pt-3">
                    <form action={markContactedAction} className="flex items-center gap-2">
                      <input type="hidden" name="leadId" value={lead.id} />
                      <input type="hidden" name="outreachId" value={draft.id} />
                      <SubmitButton pendingLabel={t.common.recording}>
                        {t.lead.markContacted}
                      </SubmitButton>
                    </form>
                    <p className="text-xs text-ink-500">{t.lead.sendingManual}</p>
                  </div>
                </>
              ) : (
                <p className="text-sm text-ink-400">
                  {t.lead.noDraft}{" "}
                  <Link href="/settings" className="text-hot hover:underline">
                    {t.lead.profile}
                  </Link>
                  {t.lead.noDraftTail}
                </p>
              )}
            </div>
          </Section>
        </div>

        <div className="space-y-4">
          <Section title={t.lead.sections.status}>
            <form action={changeStatusAction} className="flex items-end gap-2">
              <input type="hidden" name="leadId" value={lead.id} />
              <div className="flex-1">
                <label htmlFor="status" className="label block">
                  {t.lead.newStatus}
                </label>
                <select
                  id="status"
                  name="status"
                  defaultValue={lead.status}
                  className="num mt-1 w-full border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100"
                >
                  {Object.values(LeadStatus).map((value) => (
                    <option key={value} value={value}>
                      {t.enums.statuses[value]}
                    </option>
                  ))}
                </select>
              </div>
              <SubmitButton variant="quiet" pendingLabel={t.common.saving}>
                {t.common.set}
              </SubmitButton>
            </form>

            <form action={recordOutcomeAction} className="mt-4 space-y-2 border-t border-ink-800 pt-3">
              <input type="hidden" name="leadId" value={lead.id} />
              <label htmlFor="amount" className="label block">
                {t.lead.recordOutcome}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="amount"
                  name="amount"
                  type="number"
                  min={0}
                  placeholder={t.lead.amount}
                  className="num w-28 border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-50"
                />
                <button
                  type="submit"
                  name="outcome"
                  value="won"
                  className="border border-signal-green px-3 py-1.5 text-xs font-semibold text-signal-green transition-colors hover:bg-signal-green hover:text-ink-950"
                >
                  {t.lead.won}
                </button>
                <button
                  type="submit"
                  name="outcome"
                  value="lost"
                  className="border border-ink-700 px-3 py-1.5 text-xs font-semibold text-ink-300 transition-colors hover:border-ink-400"
                >
                  {t.lead.lost}
                </button>
              </div>
            </form>
          </Section>

          {nextFollowUp ? (
            <Section title={t.lead.sections.followUp}>
              <p className="num text-sm text-ink-100">
                {t.lead.due} {formatDate(nextFollowUp.dueAt, locale)}
              </p>
              <p className="mt-1 text-xs text-ink-400">{nextFollowUp.body}</p>
              <form action={completeFollowUpAction} className="mt-3">
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="followUpId" value={nextFollowUp.id} />
                <SubmitButton variant="quiet">{t.lead.markFollowUpDone}</SubmitButton>
              </form>
            </Section>
          ) : null}

          {lead.duplicates.length > 0 ? (
            <Section title={`${t.lead.duplicateCount} (${lead.duplicates.length})`}>
              <ul className="space-y-2 text-xs text-ink-300">
                {lead.duplicates.map((dup) => (
                  <li key={dup.id} className="border-l border-ink-700 pl-2">
                    {dup.originalContent.slice(0, 140)}…
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title={t.lead.sections.note}>
            <form action={addNoteAction} className="space-y-2">
              <input type="hidden" name="leadId" value={lead.id} />
              <textarea
                name="message"
                rows={3}
                placeholder={t.lead.notePlaceholder}
                className="w-full border border-ink-700 bg-ink-950 px-2.5 py-2 text-sm text-ink-50 placeholder:text-ink-600"
              />
              <SubmitButton variant="quiet">{t.lead.addNote}</SubmitButton>
            </form>
          </Section>

          <Section title={t.lead.sections.activity} className="scroll-mt-20">
            <ol id="activity" className="space-y-3">
              {lead.events.map((event) => (
                <li key={event.id} className="border-l border-ink-800 pl-3">
                  <p className="num text-[0.7rem] text-ink-500">
                    {formatDate(event.createdAt, locale)} ·{" "}
                    {t.enums.eventTypes[event.type] ?? event.type}
                  </p>
                  {/* Stored prose, written when the event happened. Only a
                      deduplicated sighting is re-rendered from its reason code. */}
                  <p className="mt-0.5 text-sm text-ink-200">
                    {eventMessageText(t, event)}
                  </p>
                </li>
              ))}
              {lead.events.length === 0 ? (
                <li className="text-sm text-ink-400">{t.lead.noActivity}</li>
              ) : null}
            </ol>
          </Section>

          <Section title={t.lead.sections.runs}>
            <ul className="space-y-2 text-xs text-ink-400">
              {lead.analyses.map((run) => (
                <li key={run.id} className="border-l border-ink-800 pl-2">
                  <p className="num">
                    {run.provider} · {run.model} ·{" "}
                    {t.enums.analysisStatuses[run.status] ?? run.status}
                  </p>
                  <p className="mt-0.5">{formatDate(run.createdAt, locale)}</p>
                  {run.error ? <p className="mt-0.5 text-hot">{run.error}</p> : null}
                </li>
              ))}
              {lead.analyses.length === 0 ? <li>{t.lead.noRuns}</li> : null}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
