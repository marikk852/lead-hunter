# Personal AI Lead Hunter

A private, single-owner tool that finds people publicly asking for software work,
scores how real the opportunity is, and drafts a reply for **you** to review and
send. It never sends anything itself.

> Normative product requirements: [docs/SPEC.md](docs/SPEC.md)
> Architecture, decisions and status: [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)

---

## What works today (Phase 1 + the vertical slice)

| Capability | Status |
| --- | --- |
| Owner login (scrypt hash, signed httpOnly cookie, throttle) | ✅ working |
| Postgres schema for leads, sources, analyses, events, outreach, follow-ups, profile, queries, notifications | ✅ migrated |
| Manual lead intake through the full pipeline | ✅ working |
| Duplicate detection (source id, content hash, author + text similarity) | ✅ working |
| Deterministic 0–100 lead scoring with an explained breakdown | ✅ working |
| Rule-based analyzer (no API key needed) | ✅ working |
| Free OpenAI-compatible analyzer (Google AI Studio by default, or Groq / OpenRouter / Mistral / Ollama) | ✅ implemented, needs `AI_API_KEY` |
| Anthropic Claude analyzer with prompt caching + structured output | ✅ implemented, needs `ANTHROPIC_API_KEY` |
| Dashboard: counters, open opportunities, follow-ups due | ✅ working |
| Lead list with search and 9 filters | ✅ working |
| Lead detail: analysis, editable draft, activity trail, outcome tracking | ✅ working |
| Owner profile + saved search queries | ✅ working |
| Two UI languages (English / Русский) with a switcher | ✅ working — [docs/I18N.md](docs/I18N.md) |
| API-key health monitor (live probe + history) in Settings | ✅ working |
| Reddit source adapter + hunt runner (saved queries → pipeline) | ✅ working, needs `npm run hunt` (OAuth optional) |
| Telegram / web source adapters, workers, Telegram alerts | ⏳ Phase 2+ |

**The loop the MVP is built around** (README §45 / docs/SPEC.md):

```
post → ingest → dedupe → analyze → score → dashboard
     → generate response → you edit → you send → mark contacted
     → follow-up reminder → reply → qualified → project
```

---

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
#    Set SESSION_SECRET:      openssl rand -hex 32
#    Set a dashboard password: npm run set-password -- --write

# 3. Database (any Postgres 16; a local Homebrew server is assumed below)
createdb lead_hunter_dev
createdb lead_hunter_test
npm run db:migrate
npm run db:seed

# 4. Run
npm run dev            # http://localhost:3000
```

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Next dev server (Turbopack) |
| `npm run build` / `npm start` | Production build and serve |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm test` | Vitest unit suites |
| `npm run lint` | ESLint |
| `npm run db:migrate` | Create/apply Prisma migrations |
| `npm run db:seed` | Seed profile, manual source, starter queries |
| `npm run db:studio` | Prisma Studio |
| `npm run set-password` | Generate `OWNER_PASSWORD_HASH` (`--write` patches `.env`) |
| `npm run ai:check` | One real model call: verify a freshly pasted key (`--screen`, `--plain "…"`) |
| `npm run hunt` | Scan every enabled saved query through the source adapters (`--dry-run`, `--limit N`, `--health`) |

### Using Postgres in Docker instead of Homebrew

```bash
docker compose up -d          # postgres on :5433, redis on :6379
# then point DATABASE_URL at it (see .env.example)
```

---

## Three ways to analyze a lead

The provider is behind one interface (`src/ai/types.ts`). `AI_PROVIDER` defaults to
**`auto`**, which uses the first provider that has a key — so the whole switch is
"paste a key", literally: **Settings → API keys** writes it into `.env` for you
(the same file, never echoed back on screen), and the app still runs with no key
at all:

| Provider | When it is used | What it costs |
| --- | --- | --- |
| `openai-compatible` | `AI_API_KEY` is set (or `AI_PROVIDER=openai`) | Whatever your endpoint costs — the defaults below are a **free tier** |
| `anthropic` | Only `ANTHROPIC_API_KEY` is set (or `AI_PROVIDER=anthropic`) | Paid, with prompt caching |
| `heuristic` | No key, or `AI_PROVIDER=heuristic` | Free, deterministic, no network |

### The free path (default)

One adapter speaks `POST /chat/completions`, so any OpenAI-compatible endpoint
works — the default is **Google AI Studio**, which needs no card, emits native
JSON-schema output and has a ~1M-token context:

```bash
# .env — this is the whole setup
AI_API_KEY="<key from https://aistudio.google.com/apikey>"
```

Swap in another free provider with two lines: `AI_BASE_URL` + `AI_MODEL`
(`https://api.groq.com/openai/v1` + `qwen/qwen3.8-27b`, `https://openrouter.ai/api/v1`,
`https://api.mistral.ai/v1`, or a local `http://127.0.0.1:11434/v1` Ollama with any
model name). Then confirm it works in one command:

```bash
npm run ai:check          # provider, model, analysis, score, token usage
```

How the free provider stays trustworthy: it asks the endpoint for strict
JSON-schema output, **re-validates the answer with the same Zod schema** and, if a
vendor rejects that request shape, degrades `json_schema → json_object → plain`
recording each step in the run notes instead of losing the lead. Prefix caching on
these vendors is automatic, so only the frozen prompt matters — and it is the same
frozen prompt the cached Anthropic path uses.

`AI_PROVIDER=anthropic` still works exactly as before: Claude returns a strict
JSON object validated by Zod, the frozen system prompt carries a `cache_control`
breakpoint with all volatile data after it, and a cheap model screens while the
strong model analyses and drafts.

Set `AI_DAILY_CALL_LIMIT` to cap model calls per day; rule-based runs are never
counted.

Settings → **Key health** probes the active key with one tiny real request and
files the result (with the provider's own answer and latency) as monitoring
history — so you can see *when* a free tier went flaky, not just that a lead
failed. Probes are two attempts max and never spend the analysis budget.

---

## Languages

The console renders in **English or Russian**, chosen from the segmented control in
the header (also on the sign-in screen, so you never have to read a language you
do not know to log in). The choice is stored in the `lh_locale` cookie and read on
the server, so a screen is already in the right language on the first paint: no
flash, no hydration mismatch, no i18n bundle in the browser.

Two rules keep it honest:

- **UI copy lives in `src/i18n/*`**, not inline in a page. `src/i18n/ru.ts` is
typed as `Dictionary`, so a missing or renamed key fails `npm run typecheck`.
- **Failures travel as codes, not English sentences.** Actions redirect with
  `?warning=budgetExceeded` / `?error=contentTooLong`, and the screen localizes the
  code. One code, two sentences — and a URL can never carry the `%` that once
  crashed the page.

Dates, relative times and budget numbers are formatted with `Intl` using the active
locale, not with hand-written strings. The AI's own output (reasoning, drafts) and
the stored `lead_events` log lines stay in the language they were produced in —
translating them would invent facts. Full rationale, the file list and the
three-step recipe for adding a language: [docs/I18N.md](docs/I18N.md).

---

## Safety rules built into the code

- Nothing is ever sent, posted or replied to automatically. Drafts are stored as
  `Outreach` rows with status `DRAFT`; you mark them sent yourself.
- One broken source or a failed AI call cannot lose a discovery: the lead is saved
  first, then analyzed, and a failure is recorded on the lead.
- Non-leads are **archived**, never deleted, so you can overturn the call.
- Duplicates attach to the original lead instead of creating a second row.
- Every server action re-checks the session, because server actions are public
  POST endpoints.

---

## Project layout

```
app/                      Next.js App Router screens
  (app)/dashboard         overview
  (app)/leads             list, filters, detail, manual intake
  (app)/settings          profile + saved queries
src/
  ai/                     provider interface, prompts, schemas, providers
  leads/                  pipeline, scoring, dedupe, queries, outreach
  auth/                   password hashing, session token, throttle
  sources/                source adapters (Reddit) + the hunt runner
  i18n/                   locale config, en/ru dictionaries, server entry point, cookie action
  components/             shared UI: language switcher, submit/copy buttons, formatters
  lib/                    env, logger, text utils, params, prisma client
prisma/                   schema + migration + seed
tests/                    vitest suites (scoring, dedupe, heuristics, prompts, auth, i18n)
docs/                     SPEC.md (requirements) + IMPLEMENTATION.md (how it was built) + I18N.md
```
