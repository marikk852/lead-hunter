# Lead Hunter — security

A single-owner, local-first tool. This file states the threat model, the controls
that exist, and **what is deliberately not protected** — so nothing here is
mistaken for a hardened multi-user service.

---

## 1. Threat model

| Asset | Who would want it | Exposure |
| --- | --- | --- |
| AI provider keys (`AI_API_KEY`, `ANTHROPIC_API_KEY`) | Anyone who can read `.env` or scrape a log | Spend money on your account |
| `PERPLEXITY_API_KEY` | Same | Spend money (per-request billing) |
| `REDDIT_CLIENT_ID/SECRET` | Same | Act as your app against Reddit |
| `SESSION_SECRET` | Anyone on the local network | Mint a session cookie |
| Lead data (public posts) | Low sensitivity | Contains public text and handles only |
| Drafted replies | Low sensitivity | Stored as `Outreach` rows; nothing is sent |

The realistic attacker for this deployment is a process or person **on the same
machine**, or a malicious website the owner visits while the console is open.

## 2. Controls

- **No automatic outreach.** There is no send transport anywhere in the
  codebase. Drafts are `Outreach` rows with status `DRAFT`; the owner sends them
  by hand. This is a structural control, not a policy (SPEC §2 is non-negotiable).
- **Session.** scrypt-hashed owner password (colon-separated encoding, chosen
  because both `@next/env` and dotenv expand `$VAR` inside `.env` values and once
  silently corrupted a `$`-separated hash). Stateless HMAC-signed httpOnly cookie,
  `sameSite=lax`, `secure` in production, payload limited to `v/iat/exp`.
- **Every stateful server action calls `requireOwner()`** (server actions are
  public POST endpoints). Counted in the audit: 5/5 in settings, 9/9 in leads.
- **Login throttle** (in-memory) after repeated failures.
- **Prompt injection.** All three system prompts state that the post is untrusted
  data whose embedded instructions must be ignored, and that an attempt to
  manipulate the classifier is itself a spam signal. The lead is always placed in
  the user message, after the cache breakpoint, never in the system prompt.
- **Schema validation.** Every model response is re-validated with the same Zod
  schema that was sent as the structured-output format; malformed output is an
  error, never a lead.
- **No SSRF.** The only outbound HTTP calls go to fixed hosts: the configured AI
  base URL, `https://api.perplexity.ai`, and Reddit (`www.reddit.com` /
  `oauth.reddit.com`, overridable by env for tests only). No user-supplied URL is
  ever fetched.
- **Read-only sources.** Source adapters only call search endpoints. No posting,
  voting, messaging, or authentication bypass; no CAPTCHA or access-control
  circumvention; results keep their original URL.
- **Least data.** Only what lead generation needs: public text, author handle,
  permalink, timestamps. No email harvesting, no scraping behind a login.
- **Bounded spend.** Per-call timeouts, capped retries with backoff, and
  `AI_DAILY_CALL_LIMIT` as a hard daily ceiling; the hunt stops when it is hit.
- **Logs.** Structured JSON lines carry provider/model/status/error text — never
  a key. Verified by inspection of all `logger.*` call sites.

## 3. Accepted risks (documented, not fixed)

| # | Risk | Why it is accepted |
| --- | --- | --- |
| S1 | Keys are stored **plaintext in `.env`** (and Settings writes them there). | Standard for a local dev tool; the file is gitignored and never rendered back to the client. It is the single source of truth the app reads at boot. |
| S2 | Login throttle state is in-memory; a restart clears it. | Single user, localhost. Persisting attempts is a cheap later improvement. |
| S3 | No explicit CSRF tokens. | Cookie is `SameSite=Lax`, actions are POST-only, and Next.js server actions verify the `Origin` header. A negative test is still owed (Phase 8). |
| S4 | `src/lib/logger.ts` has **no redaction layer**. | Nothing logs secrets today (verified by grep over every call site), but redaction is defence-in-depth for future call sites. |
| S5 | No rate limiting on non-login server actions. | Localhost, one owner. Revisit if the console is ever exposed. |
| S6 | `docker-compose.yml` ships a literal dev Postgres password. | Localhost-only dev credential, also documented in `.env.example`. |
| S7 | The console is HTTP on localhost in development. | `secure` cookies are enabled in production builds; do not expose the dev server to a network you do not trust. |
| S8 | Prompt-injection defence is instruction-level, not a hard sandbox. | A model can still be deceived by a sufficiently original attack; the compensating controls are the deterministic rule layer, the archived-not-deleted non-leads, and the human sending every message. |

## 4. Retention

No automatic retention policy exists. Every history table
(`lead_events`, `ai_analyses`, `scan_runs`, `scan_source_results`) grows
monotonically; AI key-health history is pruned to the newest 50 probes. Manual
cleanup queries and a backup recipe are in
[OPERATIONS.md §5](OPERATIONS.md#5-backups-and-retention).

## 5. Reporting

This is a personal project with no security contact. If you run it beyond your
own machine, fix S1–S7 first: move secrets to a secret manager, persist the login
throttle, add CSRF tokens where the framework does not already cover them, add
logger redaction, and put the console behind TLS and an auth proxy.
