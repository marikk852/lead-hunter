# Lead Hunter — Audit (Phase 1)

Baseline inspection of the repository as it exists on 2026-10-18, before the
Phase 2+ work. Everything below is marked by **how** it was verified: read in
code (`src/…:line`), executed on this machine (command + result), or not
verified at all (blocked — stated explicitly). Nothing is claimed to work
because an adapter file merely exists.

Normative requirements: [SPEC.md](SPEC.md). Phase plan: [IMPLEMENTATION.md](IMPLEMENTATION.md).
There is no `CLAUDE.md` in this repository; agent conventions live in
`AGENTS.md` (Next.js rules block + project conventions).

---

## 1. Running the baseline (executed)

| Command | Result |
| --- | --- |
| `npm test` | **181 passed (14 files)** — scoring, dedupe, heuristics, prompts (frozen), auth, i18n parity, params, text, provider selection, openai/anthropic providers (injected fetch), sources/hunt, pipeline idempotency |
| `npx tsc --noEmit` | **exit 0** |
| `npx eslint` | **0 errors, 0 warnings** |
| `npm run build` | **exit 0** — Next 16.4.1 (Turbopack); 8 routes, all dynamic (`/`, `/dashboard`, `/leads`, `/leads/[id]`, `/leads/new`, `/login`, `/settings`, `/_not-found`) |
| `npx prisma migrate status` | **up to date** — 1 migration (`20261015163718_init`), Postgres 16 @ 127.0.0.1:5433 |
| `npm run dev` + HTTP probe | `/login` 200, browser session drives `/settings`, `/leads`, `/dashboard` |
| `npm run ai:check` (live) | **exit 0** through Google AI Studio (`gemini-3.8-flash`); an earlier full pipeline run stored `SUCCEEDED` analysis `openai-compatible \| gemini-3.8-flash \| FULL` for lead `cmva712ms…` with `lead_score=67` |
| Settings → API keys (live UI) | rejected value (`?error=keyInvalid`, file untouched), write round-trip into `.env`, clear round-trip, `AI_API_KEY` fingerprint unchanged throughout |

Environment totals: 21 env vars from `.env`; `.env.test` now forces
`AI_PROVIDER=heuristic` so the default suite runs offline (§16: the suite must
not depend on paid APIs).

## 2. Verified in code

- **Auth** — scrypt password hash without `$` (survives dotenv expansion),
  signed `lh_session` cookie (`httpOnly`, `sameSite=lax`, `secure` in
  production; payload only `v/iat/exp`), in-memory login throttle
  (`src/auth/rate-limit.ts`). Every stateful server action re-checks
  `requireOwner()`: `app/(app)/settings/actions.ts` 5/5,
  `app/(app)/leads/actions.ts` 9/9. `src/auth/actions.ts` (login/logout) and
  `src/i18n/actions.ts` (locale) are unauthenticated **by design** — the locale
  action only sets a validated display cookie (`isLocale` check) and must work
  on the sign-in screen.
- **Pipeline** (`src/leads/pipeline.ts`) — lead row is created **before** the AI
  call; analysis failure writes `analysisStatus=FAILED` + an event and keeps the
  lead; success persists `aIAnalysis` and lead fields in one `$transaction`
  (`pipeline.ts:259`); non-leads are `ARCHIVED`, never deleted.
- **Dedupe** (`src/leads/dedupe.ts`) — three signals: `@@unique(sourceId,
  sourceExternalId)`, exact `contentHash`, and author-aware text similarity
  (0.72 same author / 0.88 cross author) over a bounded candidate pool
  (120 days / 300 rows). Sequential re-ingestion is idempotent (test-verified).
- **Scoring** (`src/leads/scoring.ts`) — single deterministic 0–100 model, per
  factor `points = normalized × weight`, full breakdown persisted on the lead
  (`score_breakdown`), non-lead cap, HOT/WARM/COLD thresholds. This is the only
  scoring system in the repo (the spec's suggested weights map onto these
  factors; no second implementation exists).
- **AI layer** (`src/ai/`) — one provider interface, three implementations
  (keyless rules, OpenAI-compatible, Anthropic with prompt caching). Strict
  JSON-schema request → `json_object` → `plain` degrade ladder, always
  re-validated by the same Zod schema before persistence. Bounded retry/backoff
  for 429/5xx and transport failures (`openai-compatible.ts` — added this
  session after real 503s), per-call `usage` (tokens + cache) persisted,
  daily budget `AI_DAILY_CALL_LIMIT` enforced both by the provider wrapper and
  inside the hunt loop. Prompts are frozen (no dates/ids/per-lead data) and
  guarded by `tests/prompts.test.ts`.
- **Reddit adapter** (`src/sources/reddit.ts`) — real client: OAuth2
  client-credentials against `www.reddit.com/api/v1/access_token` +
  `oauth.reddit.com/search`, and an unauthenticated fallback to
  `www.reddit.com/search.json` when `REDDIT_CLIENT_ID/SECRET` are absent.
  Permalink/user/title/body captured, base-URL overrides exist for tests
  (fixtures use a local stub — clearly test-only).
- **Hunt driver** (`src/sources/run.ts`) — updates `SearchQuery.lastRunAt` and
  `Source.lastScanAt`, stops on the daily AI limit, called manually via
  `npm run hunt`.
- **UI** — dashboard (hot/warm/cold, contacted/replied, failed analyses tile,
  potential-revenue pool), lead list with search + 9 filters + real pagination
  (`src/leads/queries.ts` `page/pageSize/pageCount`), lead detail (analysis,
  editable draft, activity trail, status), manual intake with live-provider
  badge, settings (profile, AI provider status + API-key form), EN/RU rendering
  from a cookie **on the server** (no hydration flash; typed dictionaries +
  parity tests; failures travel as URL codes, never sentences).
- **Outreach safety** — `Outreach` rows are `DRAFT`; there is **no send
  transport anywhere in the codebase** (copy-to-clipboard is client-side only).
  Compliance rule "never send automatically" is enforced structurally.
- **Config parity** — sampled 10 env names: every `env.ts` key checked is
  documented in `.env.example` (incl. `AI_EFFORT`, `AI_DAILY_CALL_LIMIT`,
  `REDDIT_*`, `REDIS_URL`, `TELEGRAM_*`).
- **SSRF** — no `fetch()` of caller-supplied URLs exists; outbound HTTP goes to
  fixed Reddit hosts (and, when configured, vendor AI endpoints).

## 3. Verified through execution

Listed in §1. Additionally, this session end-to-end: a lead created through the
same `ingestLead` entry point the form calls was analyzed by the live Gemini
key, scored, and rendered in the UI; Settings → API keys wrote and cleared real
`.env` lines with the file's other content byte-stable. The Settings key
monitor was exercised against the live free tier in both directions: one probe
recorded a real `HTTP 503` (vendor message stored verbatim, 2 attempts,
2292 ms) and the next recorded `HTTP 200` — which is exactly the signal the
monitor exists to produce.

## 4. Mocked / simulated only

- **Reddit network responses in tests** — `REDDIT_BASE_URL` points at a local
  stub in the test suites. This is honest test isolation, but it means *the test
  suite proves the parsing, not live Reddit access*. Live status: **probed
  2026-10-18 from this network — blocked without credentials**:
  `www.reddit.com/search.json` → HTTP 403 (block page), `api.reddit.com` → 403,
  `old.reddit.com` → 302. The unauthenticated fallback is refused by Reddit
  here, so live Reddit verification is **blocked pending `REDDIT_CLIENT_ID/
  SECRET`** (user's own app credentials; documented in `.env.example`).
- **`REDIS_URL`** — documented in `.env.example`, **no redis client in
  dependencies, no code reads it**. Aspirational config; either the Phase 4
  queue uses it or it must be removed from the template.
- **`Source.health`** — column and `healthCheck()` concept exist in the schema;
  `run.ts` never writes it (only `lastScanAt`). A UI health badge would show
  empty forever. Nothing claims it works today, which is why this is listed
  here rather than as a bug.
- **`Notification` model** — table exists, no producer (Telegram adapter is
  Phase 2+ per README) and no reader UI.

## 5. Incomplete vs. the specification

| # | Spec section | Gap |
| --- | --- | --- |
| 1 | §12 Scheduling | **No scheduler at all.** Only `npm run hunt` by hand; the `run.ts` header itself says the future worker/cron will call it. No job table, no overlap protection, no retry history, no manual-run UI, no restart recovery (§12 explicitly: "a command that works manually is not proof that scheduled execution works"). |
| 2 | §6 Provenance | Leads record the **source adapter**, never **which search query** found them (`SearchQuery → Lead` link absent; neither `pipeline` nor `run.ts` puts the query into `lead_events.metadata`). Query-quality analytics (§11) is therefore impossible. |
| 3 | §7 Stage A | **`provider.screen()` is dead code from the pipeline's perspective** — `AnalysisStage.SCREEN`, `SCREEN_SYSTEM_PROMPT` and each provider's `screen()` exist, but `pipeline.ts` never calls `screen()`; every post goes straight to FULL analysis (higher token cost, no cheap deterministic noise cut before spend). `grep -n 'screen(' src/leads/*.ts src/sources/*.ts` → no call sites. |
| 4 | §7 Prompt injection | **No injection guard** in `src/ai/prompts.ts`: system prompts do not state that the post is untrusted data whose instructions must be ignored. |
| 5 | §9 Statuses | `NO_RESPONSE`, `NOT_A_FIT`, `DISMISSED` do not exist (`REJECTED`/`ARCHIVED` approximate two of them). No `REVIEW` ambiguity label either — spec explicitly allows the mapping to be adapted, but the missing `NO_RESPONSE` blocks clean reply-rate analytics later. |
| 6 | §5 Search profiles | Saved queries exist (CRUD, enable/disable, `lastRunAt`), but there are no per-profile frequency/limits, exclusion keywords, max-post-age or per-profile language filters. |
| 7 | §11 Analytics | Dashboard shows counts; **no funnel conversion rates, no per-source/per-query performance, no AI cost view** (the `usage` rows needed for cost already exist). "Revenue" tile is the *potential budget pool of open leads*, not owner-recorded revenue — owner-entered project value is not in the schema at all. |
| 8 | §16 E2E | No browser-driven end-to-end suite (sign-in → discover → draft → send → reply → outcome). Current 181 tests are unit + DB integration with test doubles for network. |
| 9 | §13 Retention | No retention/deletion policy for old leads, events, analyses, or `raw` payloads. |
| 10 | §20 Docs | `AUDIT.md` (this file) newly created; `ARCHITECTURE.md`, `OPERATIONS.md`, `SECURITY.md` still missing. |

## 6. Defects — found and status

| Defect | Status |
| --- | --- |
| Concurrent ingest crashed with Prisma `P2002` (unique `sourceId+sourceExternalId` race between the dedupe pre-check and `lead.create`) — spec §6 demands idempotent, concurrency-safe ingestion | **Fixed this phase**: `pipeline.ts` catches the unique violation, attaches to the winning row, records a `DEDUPLICATED` event; regression tested in `tests/pipeline.test.ts` (race row outside the candidate window + sequential idempotency, both offline). |
| Settings → Anthropic placeholder claimed "saved" using the `hasOwnAnthropicKey`-vs-`hasAnthropicKey` fallback alias — a value the owner never typed | **Fixed this phase**: strict `hasOwnAnthropicKey()` used for the form; verified live (placeholder flips to "not set" after clear). |
| Live Gemini free tier returned 503/429 mid-session | **Fixed this phase**: bounded retry with backoff for transient statuses in `openai-compatible.ts` (+ test); sustained outages still surface as an explicit error rather than a silent heuristic fallback pretending to be a model run. |
| Key with `$` would be silently truncated by dotenv expansion (AGENTS.md rule) | **Prevented this phase**: `sanitizeApiKey` refuses `$`/control characters with a localized error (test-verified). |
| Dev-only console noise: HMR WebSocket handshake failures and one `403 /__nextjs_font/geist-latin.woff2` in `next dev` | **Observed, not a product defect**: production build serves all app chunks (200/304 verified over the network log); noise comes from the dev tooling path through the preview proxy. No action beyond this note. |

## 7. Security risks (prioritized)

| # | Risk | Assessment |
| --- | --- | --- |
| S1 | API keys typed into Settings are stored **plaintext in `.env`**, and `OWNER_PASSWORD` may exist as a plaintext fallback | Acceptable for a single-owner local tool **if documented**; goes into `SECURITY.md`. Never echoed to the client, never logged (grep-verified: logs carry only provider/model/baseUrl/status). |
| S2 | Login throttle state is in-memory — restart clears the counters | Low impact single-user; document. Persisting attempts is a cheap later improvement. |
| S3 | No explicit CSRF tokens on server actions | Mitigated: cookie is `SameSite=Lax`, actions are POST-only, and Next.js server actions verify the `Origin` header against the host (framework behavior). To be re-confirmed with a negative test in Phase 8. |
| S4 | `src/lib/logger.ts` has **no redaction layer** | Nothing logs secrets today (verified by grep over all `logger.*` call sites), but redaction is defense-in-depth for future call sites — add before Phase 8 sign-off. |
| S5 | Prompt-injection guard missing in system prompts | Real gap (spec §7): posts are attacker-controlled text. Scheduled fix in Phase 2 (item 4 of §5). |
| S6 | No rate limiting on non-login server actions | Acceptable on localhost for one owner; note in `SECURITY.md`, revisit if exposed publicly. |
| S7 | `docker-compose.yml` ships a literal dev Postgres password | Localhost-only, documented as dev credential in `.env.example`; flagged for a compose-env-var conversion as optional cleanup. |

## 8. Prioritized implementation plan

**P0 — correctness of the core promise (Phase 2)**
1. Prompt-injection guard in the frozen system prompts (+ `PROMPT_VERSION` bump, prompts tests stay green).
2. Wire the cheap Stage A: `screen()` before FULL analysis, `SKIPPED`/`ARCHIVED` for obvious non-leads, thresholds covered by tests.
3. Query provenance: additive migration (`Lead.searchQueryId` nullable + relation), threaded through `run.ts`, surfaced on lead detail.

**P1 — reliability (Phase 3–4)**
4. Live Reddit probe through the public path (or OAuth once credentials exist); honour `Source.health` writes in `run.ts`; document rate-limit behaviour.
5. Scheduler: persistent job table, per-source schedule, overlap lock, bounded retries, manual run/retry UI, restart recovery (uses `run.ts` unchanged — its contract already anticipates a worker).

**P2 — lead management depth (Phase 5)
6. `NO_RESPONSE` / `NOT_A_FIT` status additions (additive enum migration), merge-duplicates UI, false-positive overturn flow.

**P3 — analytics & operations (Phase 6/8)
7. Funnel + conversion metrics, per-source/per-query quality, AI cost from `usage` rows, owner-recorded project value.
8. Docs: `ARCHITECTURE.md`, `OPERATIONS.md` (cron, backups, troubleshooting), `SECURITY.md`; logger redaction; E2E happy path; retention policy.

**Definition-of-done tracker**: install/build ✓ · migrations ✓ · auth ✓ ·
real source live data ⬜ (still blocked: no Reddit credentials; public JSON path
offers HTTP 403 from this network, OAuth implemented but unexercised live) ·
scheduled discovery ✓ (Phase 2 follow-up: lease + run log + cron entry point) ·
idempotent duplicates ✓ · provenance ✓ (source-level and query-level since the
Phase 2 follow-up) · qualification with structured output + fallback ✓ ·
explainable scores ✓ · review/filter UI ✓ · editable drafts, manual send ✓ ·
replies/follow-ups partial (schema + UI ✓, no E2E) · failures visible ✓ (per-lead
status, dashboard tile, per-source run status + `sources.health`) ·
tests/typecheck/lint/build ✓ · security limitations documented ✓
(`SECURITY.md`, Phase 2 follow-up) · new-developer install path ✓ (README) ·
usable without fake data ✓ (manual intake + live key verified).

---

## 9. Phase 2 follow-up (2026-10-19)

This section updates §5–§7 after the Phase 2 work; the tables above remain the
snapshot that motivated it.

### 9.1 Gaps closed

| §5 # | Gap | Status after this phase |
| --- | --- | --- |
| 1 | No scheduler at all | **Closed (cron, not a queue).** `scripts/hunt-cron.sh` + `job_locks` lease + `scan_runs`/`scan_source_results`; manual run and dry-run via `npm run hunt`. Verified: overlap rejected, crashed-lease recovery via expiry, run log rows written. |
| 2 | No query provenance | **Closed.** `leads.search_query_id` (nullable, `ON DELETE SET NULL`) threaded through the runner and rendered on the lead page. |
| 3 | `screen()` dead code | **Closed.** Stage A runs before the FULL analysis; rejections archive with the screen's reason; a screen failure falls through to the full analysis; manual entries skip it. Pinned by DB-backed tests. |
| 4 | No prompt-injection guard | **Closed** in all three system prompts (`PROMPT_VERSION` `2026-10-19.1`), plus a rule that a manipulation attempt is itself a spam signal. |
| 10 | Docs missing | **Closed:** `ARCHITECTURE.md`, `OPERATIONS.md`, `SECURITY.md` added; README and IMPLEMENTATION updated. |
| — | Second source | **Closed:** Perplexity Search API adapter, gated on `PERPLEXITY_API_KEY` (paid, so opt-in), documented cost and honest failure semantics. |

### 9.2 Gaps still open

| §5 # | Gap | Note |
| --- | --- | --- |
| 5 | `NO_RESPONSE` / `NOT_A_FIT` statuses | Unchanged; still approximated. Needs an additive enum migration. |
| 6 | Per-profile query settings (frequency, exclusions, max age, language) | Unchanged. |
| 7 | Funnel/conversion/per-query analytics, AI cost view, owner-recorded revenue | Unchanged — but the data needed for per-query analysis now exists. |
| 8 | Browser E2E suite | Unchanged. The console was verified by execution (production build, authenticated requests), not by a checked-in Playwright suite. |
| 9 | Retention policy | **Partly closed:** no automation, but `OPERATIONS.md §5` documents safe manual cleanup queries. |

### 9.3 New defects found and fixed in this phase

| Defect | Evidence |
| --- | --- |
| `BudgetExceededError` was swallowed by the per-lead catch in `pipeline.ts`, so a hunt never actually stopped at `AI_DAILY_CALL_LIMIT` — it kept issuing calls that could only fail, and `run.ts`'s budget branch was unreachable from the ingest path. | Code path traced; `BudgetExceededError` now rethrown from the pipeline and handled in the runner (which is what its tests already asserted). |
| The job lease compared a naive `locked_until` timestamp against Postgres `NOW()`. The server clock/timezone offset made a live lease look expired: a planted lock did **not** block a scan (observed: run count 2 → 3). | Both sides of the comparison now use the application clock; re-tested: lock planted → scan skipped, run count unchanged. |
| Failed Reddit search noise: every 403 body was truncated at 200 chars and stored verbatim in `sources.health` / run rows, which is what it is, but the run had no way to distinguish "blocked" from "misconfigured". | Failures now carry a code (`auth` here); the health detail appends the concrete fix (set `REDDIT_CLIENT_ID/SECRET`). |

### 9.4 Live-source status (unchanged, and why)

- **Reddit:** still no live data. `www.reddit.com/search.json` answers **HTTP 403**
  from this network, and Reddit's current policy states unauthenticated
  programmatic access is blocked. The OAuth2 client-credentials implementation is
  complete and pinned by tests with an injected `fetch`; the only remaining step
  is the owner's own app credentials.
- **Perplexity:** endpoint reachable (**HTTP 401** with a deliberately invalid
  key, classified `auth`); no real key is configured, so no live results were
  retrieved. Nothing is claimed beyond that.

**Remaining blocker for "real public data":** one source credential the owner
must supply — either `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` (free) or
`PERPLEXITY_API_KEY` (paid). Everything else in the pipeline is ready and
verified offline.