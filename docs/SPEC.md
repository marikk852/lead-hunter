# Lead Hunter — normative product requirements

This is the implementation-facing extract of the product brief. The narrative
vision, examples and mock-ups live in the original brief; everything below is
binding on the implementation.

> The rule that overrides everything else: **the goal is to find at least one real
> client using this system.** Quality of leads beats quantity.

## 1. Core principle

Optimise for lead quality, not volume. A lead should ideally show: clear project
intention, recent activity, an identifiable need, realistic scope, potential
budget, reasonable urgency, a legitimate way to make contact, and enough context
to write a personal reply.

## 2. Compliance (non-negotiable)

The system must never become a spam bot.

```
SEARCH → ANALYZE → QUALIFY → GENERATE RESPONSE → HUMAN APPROVAL → USER SENDS
```

- The owner stays in control of all outreach. No automatic messaging in the MVP.
- Respect source ToS, API restrictions, robots.txt, rate limits, privacy rules and
  anti-spam rules.
- Collect only what is necessary for lead generation.
- Do not bypass authentication, CAPTCHAs, access restrictions or private groups.

## 3. Scoring

Factors and weights (deterministic, recomputed on every analysis):

| Factor | Weight |
| --- | --- |
| Intent | 30% |
| Project clarity | 15% |
| Budget | 15% |
| Urgency | 15% |
| Business legitimacy | 10% |
| Contactability | 5% |
| Recency | 5% |
| Project fit | 5% |

Temperature bands: **HOT ≥ 80**, **WARM 50–79**, **COLD < 50**.

The algorithm may be improved later using historical outcomes, but must stay
reproducible and testable.

## 4. Lead categories (extensible)

`WEBSITE, WEB_APP, MOBILE_APP, WORDPRESS, WOOCOMMERCE, SHOPIFY, TELEGRAM_BOT,
DISCORD_BOT, CRM, AUTOMATION, AI, API_INTEGRATION, SEO, PERFORMANCE, BUG_FIX,
REDESIGN, E_COMMERCE, LANDING_PAGE, CUSTOM_SOFTWARE, OTHER`

## 5. Lead statuses

`NEW, REVIEWED, CONTACTED, REPLIED, QUALIFIED, NEGOTIATION, WON, LOST, REJECTED,
ARCHIVED`

Primary flow: `NEW → REVIEWED → CONTACTED → REPLIED → QUALIFIED → NEGOTIATION → WON`.
Alternatives: `CONTACTED → LOST`, `CONTACTED → NO_RESPONSE`, `REVIEWED → REJECTED`,
and low-score items → `ARCHIVED`.

## 6. AI output contract

Every analysis must be structured and schema-validated. Required fields:
`isLead, confidence, category, projectDescription, intentScore, budget{min,max,currency},
urgency, location, businessType, requirements[], painPoints[], recommendedService,
reasoning`. Free-form AI output must never be trusted; malformed output is an error,
not a lead.

## 7. Response generation rules

- Personalised from the actual post, never a generic pitch.
- The AI must NEVER invent prior projects, clients, technologies, prices,
  certifications, experience or guarantees. Only facts from the owner profile.
- Human approval always required before sending.

## 8. Data model

`User, Lead, Source, LeadEvent, AIAnalysis, Outreach, FollowUp, DeveloperProfile,
SearchQuery, Notification`, with `Lead` related to `Source, AIAnalysis, LeadEvents,
Outreach, FollowUps`.

Lead fields: `id, source, source_id, source_url, source_author, source_created_at,
original_content, title, category, project_description, intent_score, lead_score,
temperature, budget_min, budget_max, budget_currency, urgency, location,
business_type, requirements, pain_points, ai_analysis, ai_model, ai_processed_at,
status, created_at, updated_at`.

## 9. Architecture requirements

- Source adapters behind one interface (`search`, `normalize`, `healthCheck`);
  adding a source must not require rewriting the core. Each adapter fails
  independently.
- AI providers behind one interface (`analyzeLead`, `generateResponse`); provider
  and model configurable by environment variable.
- Duplicate detection using: source ID, source URL, author username, normalized
  text, text similarity, and semantic similarity where appropriate.
- No long-running scans inside HTTP requests (Phase 2 workers; queue-based).
- Two-layer discovery for cost control: cheap keyword/rule filtering first, AI only
  for promising candidates; cheap model for stage-1 classification, stronger model
  for valuable leads.
- Strict validation of all external data; AI responses validated against schemas.
- TypeScript strict mode; no hardcoded secrets; `.env.example` provided.
- Structured logging of every important operation; never log credentials.
- Tolerate source outages, API timeouts, rate limits, AI failures, malformed AI
  responses, database failures, duplicate jobs and network errors. Workers retry
  with exponential backoff.

## 10. Phase plan (do not skip ahead)

1. **Foundation** — Next.js dashboard, auth, Postgres, Prisma, Lead + Source models,
   lead status, basic dashboard.
2. **First source** — Reddit end to end (search → collect → normalize → dedupe → save).
3. **AI** — classification, category, score, budget, urgency, description, reasoning.
4. **Dashboard** — list, filters, search, detail, AI analysis, status changes.
5. **Response generation** — generate, edit, copy, open source, mark contacted.
6. **Telegram notifications** to the *owner* (never to leads).
7. **Second source** — Telegram/public sources where legally permitted.
8. **Analytics** — reply rate, qualification rate, conversion, source performance,
   revenue.

MVP success = discover automatically, remove noise, detect real clients, analyse and
score them, prevent duplicates, display them, generate a personalised response,
notify on HOT leads, and track every outcome.

## 11. Do not build yet

Public marketplace, subscriptions, payments, multi-user system, mobile app,
complex machine learning, automatic mass outreach, automatic spam, complex admin,
dozens of integrations, unnecessary microservices.

## 12. Environment variables

`DATABASE_URL, AI_PROVIDER, AI_API_KEY, ANTHROPIC_API_KEY, AI_MODEL, AI_MODEL_FAST,
TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID, REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET,
REDIS_URL, NEXTAUTH_SECRET/SESSION_SECRET`. Never commit `.env`.
