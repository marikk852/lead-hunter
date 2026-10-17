import { createLeadAction } from "@/app/(app)/leads/actions";
import { SubmitButton } from "@/src/components/client-buttons";
import { Section } from "@/src/components/ui";
import { SourceKind } from "@/src/generated/prisma/enums";
import { getAIProvider } from "@/src/ai";
import { errorText, getI18n, template } from "@/src/i18n";
import { MAX_CONTENT_LENGTH } from "@/src/leads/pipeline";
import { readParam } from "@/src/lib/params";

/** The example posts stay in English: they are English-language posts to paste. */
const EXAMPLES = [
  {
    labelKey: "exampleStrong",
    text: "Need a WooCommerce store for our construction company. Budget around €2,000, want it live this month. We have about 40 products and need a quote request form.",
  },
  {
    labelKey: "exampleWeak",
    text: "I'm thinking about maybe getting a website for my bakery one day. Is it worth it?",
  },
  {
    labelKey: "exampleNotLead",
    text: "Anyone know a good React course? Want to get better at hooks before I apply for jobs.",
  },
] as const;

export default async function NewLeadPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { t } = await getI18n();
  const params = await searchParams;
  const error = errorText(t, readParam(params, "error"), { limit: MAX_CONTENT_LENGTH });
  const provider = getAIProvider();

  return (
    <div className="space-y-5 rise">
      <header>
        <p className="label">{t.newLead.kicker}</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink-50">
          {t.newLead.heading}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-400">
          {template(t.newLead.intro, {
            provider:
              provider.name === "heuristic" ? t.newLead.providerRules : provider.name,
          })}
        </p>
      </header>

      {error ? (
        <p role="alert" className="border-l-2 border-hot pl-3 text-sm text-hot">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <form action={createLeadAction} className="panel space-y-4 p-4 lg:col-span-2">
          <div>
            <label htmlFor="content" className="label block">
              {t.newLead.contentLabel}
            </label>
            <textarea
              id="content"
              name="content"
              required
              rows={8}
              placeholder={t.newLead.contentPlaceholder}
              className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-2 text-sm leading-relaxed text-ink-50 placeholder:text-ink-600"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="title" className="label block">
                {t.newLead.titleLabel}
              </label>
              <input
                id="title"
                name="title"
                className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
              />
            </div>
            <div>
              <label htmlFor="sourceAuthor" className="label block">
                {t.newLead.authorLabel}
              </label>
              <input
                id="sourceAuthor"
                name="sourceAuthor"
                placeholder={t.newLead.authorPlaceholder}
                className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
              />
            </div>
            <div>
              <label htmlFor="sourceUrl" className="label block">
                {t.newLead.urlLabel}
              </label>
              <input
                id="sourceUrl"
                name="sourceUrl"
                type="url"
                placeholder="https://…"
                className="mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
              />
            </div>
            <div>
              <label htmlFor="sourceCreatedAt" className="label block">
                {t.newLead.postedLabel}
              </label>
              <input
                id="sourceCreatedAt"
                name="sourceCreatedAt"
                type="date"
                className="num mt-1 w-full border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-50"
              />
            </div>
            <div>
              <label htmlFor="sourceKind" className="label block">
                {t.newLead.sourceLabel}
              </label>
              <select
                id="sourceKind"
                name="sourceKind"
                defaultValue={SourceKind.MANUAL}
                className="mt-1 w-full border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100"
              >
                {Object.values(SourceKind).map((value) => (
                  <option key={value} value={value}>
                    {t.enums.sourceKinds[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <SubmitButton pendingLabel={t.newLead.analyzing}>{t.newLead.submit}</SubmitButton>
            <p className="text-xs text-ink-500">{t.newLead.savedEvenIfFails}</p>
          </div>
        </form>

        <Section title={t.newLead.examplesTitle}>
          <p className="text-xs leading-relaxed text-ink-400">{t.newLead.examplesHint}</p>
          <ul className="mt-3 space-y-3">
            {EXAMPLES.map((example) => (
              <li key={example.labelKey}>
                <p className="label">{t.newLead[example.labelKey]}</p>
                <p className="mt-1 border-l border-ink-700 pl-2 text-xs leading-relaxed text-ink-300">
                  {example.text}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
