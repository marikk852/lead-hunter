# Implementation notes

Companion to [SPEC.md](SPEC.md). Records what was built, why, what was actually
verified, and what is deliberately still missing.

---

## 1. Stack and the reasons for each choice

| Choice | Reason |
| --- | --- |
| **Next.js 16** (App Router, TS strict, Tailwind v4) | Server components read the database directly, so there is no separate API layer to maintain for a one-user tool. |
| **PostgreSQL 16 + Prisma 7** | Relational data with real enums and constraints. Prisma 7 needs a `prisma7.config.ts` and a driver adapter (`@prisma/adapter-pg`); the generated client lives in `src/generated/prisma` (gitignored). |
| **`cacheComponents` disabled** | Every screen reads the session cookie and live data, so there is no static shell worth prerendering. With PPR on, each dynamic read would need a Suspense boundary for no benefit. `partialPrefetching` was removed with it, since it requires `cacheComponents`. |
| **scrypt (Node built-in) for the owner password** | No native build step, no extra dependency, and the parameters are explicit in the code. |
| **HMAC-signed cookie instead of a session table** | One user. A stateless token avoids a table and a lookup on every request. |
| **Provider-agnostic AI layer** | The spec requires `AIProvider` to be swappable. `src/ai` is the only place a vendor SDK is imported. |
| **Zod for every boundary** | The spec requires external data and AI output to be validated. The same schema that constrains the model also validates the response locally. |
| **Locale in a cookie, dictionaries typed by `en`** | A one-owner console needs no URL routing for two languages, and a server-read cookie means the first paint is already correct. Typing `ru.ts` as `Dictionary` turns a forgotten string into a compile error. |

## 2. How the three providers differ

```
AI_PROVIDER=auto (default)  → the first provider below that has a key
AI_PROVIDER=openai          → any OpenAI-compatible /chat/completions endpoint:
                              Google AI Studio (default), Groq, OpenRouter,
                              Mistral, a local Ollama. The free path.
AI_PROVIDER=anthropic       → Claude, two model tiers, structured output, prompt caching.
AI_PROVIDER=heuristic       → deterministic rules. No key. Offline work and the
                              cheap first-stage filter.
```

`auto` exists so that a key is the only thing needed to switch: with `AI_API_KEY`
set the free provider is used, with only `ANTHROPIC_API_KEY` Anthropic is, and with
neither the rules run — the app is never broken by a missing key, and it never
claims a model ran when the rules did (the settings screen prints the *resolved*
provider, model and the reason as a localized code).

The OpenAI-compatible adapter is dependency-free (`fetch`, no vendor SDK) because
the whole point is to be vendor-neutral. It requests strict JSON-schema output,
re-validates the answer with the same Zod schema, and degrades
`json_schema → json_object → plain` when a vendor rejects the request shape,
recording each step in the run notes. Only 400/422 are retried: an auth or server
error is surfaced on the first try rather than masked by a second request. Caching
on these vendors is automatic and prefix-based, so there is nothing to mark — but
the frozen prefix and the estimate are still reported in the notes.

The heuristic provider is not a stub. It implements the spec's own examples:
the strong WooCommerce case scores **87/100 HOT**, the "one day maybe" bakery case
**36/100 (a lead, but COLD)**, and all five "not a lead" examples from the spec are
rejected, including the vendor advertising their own services and the
own-code debugging question.

## 3. Prompt caching

`src/ai/prompts.ts` is frozen by contract: no dates, no ids, no per-lead data, and
the lead payload uses a fixed key order so the serialized bytes do not drift.
The cache breakpoint is on the last `system` block; the lead itself is always in
`messages`, after the breakpoint. Tests assert all of this.

**Measured caveat (reported honestly):** the analysis prefix is currently
**≈1,650 tokens**, and the documented minimum cacheable prefix for Opus 4.7 and
Haiku 4.5 is **4,096 tokens**. Below that the marker is accepted but nothing is
cached — silently. The provider therefore *warns* when the prefix is too small and
records the estimate in the run notes, so this is visible rather than assumed. The
first real `cache_read_input_tokens` value will confirm it. Growing the prompt with
more calibration examples is the cheapest way to cross the threshold, and is worth
doing once a key is configured and the cache can be measured.

## 4. What was verified, and how

`npm run typecheck`, `npm run lint` and `npm test` (148 tests) all pass. Beyond
that, the full loop was driven through the real UI on a running dev server:

| Step | Observed result |
| --- | --- |
| Unauthenticated `GET /leads/<id>` | `307` to `/login` (guard works) |
| Wrong password | "Wrong password." alert, throttled after 8 tries |
| Correct password | session cookie, redirect to `/dashboard` |
| Ingest the spec's strong example | score **93/100 HOT**, intent 100/100, EUR 2,000, urgency HIGH, business Construction, `woocommerce` |
| Generate response | draft built only from profile facts (`WordPress, WooCommerce, PHP, Next.js`) |
| Mark contacted | status → CONTACTED, follow-up scheduled 3 days out, 7 activity events |
| Re-ingest the same post, reworded, same author | **no new row** — "same author, 91% text overlap", merged onto the original |
| Ingest a learning question | `ARCHIVED`, score 24/100 COLD |
| Filter `minScore=80&temperature=HOT` | 1 row, "2 filters active" |
| Save profile | persisted and revalidated |
| Switch the UI to Russian (header control) | cookie `lh_locale=ru`, `<html lang="ru">`, whole console Russian, choice survives navigation |
| Same filtered list in Russian | "1 лид", "2 фильтра активно" — the 2–4 plural form, not "2 фильтров" |
| `/leads/<id>?duplicate=overlapSameAuthor&percent=91` in Russian | "Уже в базе (тот же автор, совпадение текста 91%)"; dates as `15.10.2026, 20:01` |
| Settings with no key | Active `heuristic`, model `heuristic-rules-v1`, and the reason rendered from a code in the owner's language |
| `npm run ai:check` with `AI_API_KEY` pointing at a local stub that speaks the same protocol | real HTTP call: `Bearer` header, `response_format={"type":"json_schema","strict":true}` with the app's own schema, the post in the user message, analysis validated by Zod, score **94/100 HOT**, usage mapped, exit 0 |
| The same stub rejecting `json_schema` with 400 | retried as `json_object`, then as plain, with both degradations recorded in the run notes (also pinned by unit tests) |
| `npm run ai:check` with no key | says so, prints the free-path instructions, exits 1 |
| `npm run hunt -- --health` against a local stub serving Reddit's listing JSON | `reddit: OK — public JSON endpoint reachable`, with the right `q`, `limit` and `User-Agent` on the wire |
| `npm run hunt -- --dry-run` against the same stub | 9 seeded queries → 18 items listed, nothing written, no `last_run_at` |
| `npm run hunt` (real writes) | 2 leads created (both COLD non-leads, i.e. correctly archived), 16 duplicates suppressed by `source_external_id`, a `reddit` source row created with both leads attached, all 9 queries stamped. **The rows this verification created were deleted afterwards**, so the database is back to its previous state |

Two real bugs were found by this walkthrough and fixed:

1. **`URIError: URI malformed` (500) on the duplicate banner.** Search params are
   already percent-decoded by Next, so calling `decodeURIComponent` again crashed on
   the `%` in "91% text overlap". All param reads now go through
   `src/lib/params.ts`, with regression tests.
2. **Sign-in was impossible. Both `@next/env` and dotenv expand `$VAR` inside
   `.env` values — including inside single quotes — so `scrypt$16384$…` was
   silently rewritten to `scrypt6384`.** The stored hash format is now colon
   separated and base64url (`scrypt:16384:8:1:<salt>:<hash>`), which needs no
   quoting or escaping. Legacy `$`-separated hashes still verify.

## 5. Localization (English / Russian)

The console is fully bilingual: a segmented control in the header (and on the
sign-in screen) writes a `lh_locale` cookie, and every screen reads it on the
server through `getI18n()`. Nothing is translated in the browser, so there is no
flash of English on first paint and no i18n bundle in the client. Full rationale
and the recipe for a third language: [I18N.md](I18N.md).

Three decisions are worth recording here:

1. **The English dictionary is the type.** `ru.ts` is declared `Dictionary`, so a
   missing or renamed key is a `tsc` error, not a runtime `undefined` on screen.
   `tests/i18n.test.ts` additionally compares key paths, non-emptiness and
   `{placeholders}` across both dictionaries.
2. **Domain failures became machine-readable first.** The actions, the pipeline
   and the outreach layer now redirect with codes (`contentTooLong`,
   `budgetExceeded`, `overlapSameAuthor` + `percent`) instead of English
   sentences, and the screen localizes them. That also removed a real crash: an
   English reason in a redirect URL contained a bare `%` and the double decode
   threw `URIError`.
3. **Plurals are locale-aware.** Russian needs the 2–4 form, so `plural` takes the
   locale and three variants — the list header reads "2 лида", "5 лидов".

## 6. Known limitations

- **No call has been made to a real vendor** — neither Anthropic nor a free
  provider, because there is no key in this environment. The Anthropic request
  *shape* is pinned by tests using an injected client (cache breakpoint placement,
  `output_config.format`, effort omitted for Haiku, the 400 →
  retry-without-thinking fallback, usage mapping, rejection of malformed output).
  The OpenAI-compatible adapter was additionally exercised over real HTTP against
  a local stub that speaks the same protocol, which covers the transport, headers,
  request body, parsing and re-validation — but **a real endpoint has not answered
  yet**, and the default Gemini model ids (`gemini-3.8-flash`,
  `gemini-3.5-flash-lite`) come from the vendor's current pricing docs rather than
  from a successful call. `npm run ai:check` is the one-command way to settle it
  once a key exists.
- **The Reddit adapter has never spoken to Reddit.** No credentials are
  configured and the network call is not part of a test suite. Its request shape,
  OAuth flow, token caching and listing→item mapping are pinned by tests with an
  injected `fetch`, and the hunt was driven end to end against a local stub that
  serves the same listing JSON (9 queries → 18 items → 2 leads created, 16
  duplicates suppressed, `last_run_at` written). The real endpoint — and Reddit's
  current API terms — remain unverified. `npm run hunt -- --health` is the
  one-command way to settle it.
- Only Reddit is implemented; Telegram and web sources are not.
- No queue/worker or scheduler yet (Phase 2): `npm run hunt` is run by hand or by
  cron. The runner takes `now` and injects its store, so a worker is a wrapper
  rather than a rewrite. Telegram notifications (Phase 6) are not built either.
- Semantic (embedding) dedupe is not implemented; the current check is exact-hash,
  author match and text similarity. The spec lists semantic similarity as a
  "where appropriate" measure, not an MVP requirement.
- Free-tier limits are the vendor's, not ours. `AI_DAILY_CALL_LIMIT` still guards
  the loop, but it cannot know about a provider's own RPM/RPD ceiling (Google AI
  Studio and Groq both publish per-model limits and return 429s when exceeded,
  which surfaces as a provider error on that lead, not a retry).
- The **activity trail is stored prose**. `lead_events.message` is written once in
  English; its *type* labels are translated, and a deduplicated sighting is
  re-rendered from its stored reason code ("Дублирующий пост пропущен (тот же
  автор, совпадение текста 91%)"). Rows written before the codes refactor carry
  the reason as prose and still show in English — one such row exists in this dev
  database. The same applies to AI-generated text, which is never re-translated.
- Analytics beyond the dashboard counters is Phase 8.
- Telegram notifications are Phase 6.

## 7. Phase 2: discovery from a source

Built: the Reddit adapter and the hunt runner.

```
SearchQuery (enabled) → SourceAdapter.search() → SourceItem[] → ingestLead()
                                                                ↓
                        dedupe → analyse → score → dashboard (unchanged)
```

- **`src/sources/types.ts`** is the contract: an adapter only turns a query into
  plain `SourceItem`s. It never touches the database and never sends anything, so
  a new source is additive — implement the interface, register it in
  `src/sources/registry.ts`.
- **`src/sources/reddit.ts`** uses the documented OAuth2 client-credentials flow
  when `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` are set and falls back to the
  public `search.json` endpoint when they are not, caching the token per process.
  Credentials live in `.env` (never in a `Source` row, which only carries the
  query and non-secret settings).
- **`src/sources/run.ts`** drives every enabled query through the matching adapter
  and feeds each item to the *existing* per-item pipeline, so discovery cannot
  invent a lead the manual path would have rejected. It has no timer and takes
  `now` — the same function is meant to be called by the Phase 2 worker/cron. One
  failing adapter is recorded in the summary and the run continues; a
  `BudgetExceededError` stops the whole run, because every further item would fail
  the same way.
- **`npm run hunt`** runs one scan (`--dry-run`, `--limit N`, `--health`).

## 8. Phase 2 shape (still not built)

1. `RedditAdapter implements SourceAdapter` using an official/API-compatible client,
   reading its queries from `SearchQuery` and honouring rate limits.
2. A `source.scan` job (BullMQ on the already-running Redis, or a cron-driven
   script) that calls `ingestLead` per candidate — the pipeline needs no changes.
3. `screen()` on the provider becomes the real cost filter: heuristic first, then
   the cheap model for anything promising, then the strong model.
4. Because `ingestLead` already writes `Source`, `sourceExternalId` and `sourceUrl`,
   per-source conversion analytics become a group-by rather than a migration.
