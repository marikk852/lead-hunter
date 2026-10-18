# Lead Hunter — architecture

Companion to [SPEC.md](SPEC.md) (what is required) and [IMPLEMENTATION.md](IMPLEMENTATION.md)
(what was built and verified). This file is the map: the modules, the data flow,
and the invariants each seam is responsible for.

---

## 1. The loop

```
                 ┌──────────────────────────── saved queries (SearchQuery) ───────────┐
                 │                                                                    │
 cron / manual ──┴─→ runHuntJob ─→ lock(job_locks) ─→ ScanRun ─→ runHunt ─→ adapters │
                        │                                             │              │
                        │                                        SourceItem[]        │
                        ▼                                             ▼              │
                  ScanSourceResult  ←── per-source outcome ──  ingestLead(per item)   │
                                                                      │               │
                        dedupe → screen (Stage A) → analyse (FULL) → score             │
                                                                      │               │
                                Lead + AIAnalysis + LeadEvent ←───────┘               │
                                                                                      │
 dashboard / lead list / lead detail ←────────────────────────────────────────────────┘
        │
        └─→ generateResponse → Outreach(DRAFT) → you edit → you send → status flow → follow-up
```

Nothing in the bottom half is new in Phase 2: discovery only feeds the existing
per-item pipeline, which is why a discovered lead behaves exactly like a pasted
one.

## 2. Modules and their responsibilities

| Module | Owns | Must never do |
| --- | --- | --- |
| `src/sources/types.ts` | The adapter contract (`SourceAdapter`, `SourceItem`) and the classified failure type | Touch the database |
| `src/sources/reddit.ts` | Reddit search (OAuth2 client-credentials, public JSON fallback), timeouts, backoff, `Retry-After` | Write anything, post anything |
| `src/sources/perplexity.ts` | Perplexity Search API (`POST /search`) → items | Infer buying intent from a snippet |
| `src/sources/registry.ts` | Builds adapters from `.env` only (credentials never live in a `Source` row) | Enable a paid adapter without a key |
| `src/sources/run.ts` | Query → adapter fan-out, per-source statuses, budget stop, health writes | Contain a timer or a long-running loop |
| `src/sources/job.ts` | Single-run lease, `ScanRun`/`ScanSourceResult` logging, trigger tagging | Retry a whole run blindly |
| `src/leads/pipeline.ts` | ingest → dedupe → screen → analyse → score → persist (per item) | Send anything; swallow a budget stop |
| `src/leads/scoring.ts` | The deterministic 0–100 score and HOT/WARM/COLD bands | Call a model |
| `src/ai/*` | Provider selection, prompts, schemas, the three providers | Be imported by anything outside `src/ai` except via `getAIProvider()` |
| `src/lib/env.ts` | Validated environment | Echo a secret |

## 3. Data model additions (Phase 2)

```
SearchQuery ──1:N──> Lead.searchQueryId          provenance: which query found it
ScanRun ──1:N──> ScanSourceResult                run log, one row per adapter search
JobLock (single row, id = "hunt")                cross-process mutual exclusion
Source.health / Source.lastScanAt                last adapter outcome, per source
```

`Lead.searchQueryId` is nullable and `ON DELETE SET NULL`, so deleting a query
never deletes or hides the leads it found. `ScanSourceResult.queryId` is likewise
nullable for the same reason.

## 4. The three invariants that matter

**4.1 Idempotent ingestion.** `@@unique([sourceId, sourceExternalId])` is the
backstop; the dedupe pre-check (content hash, author + text similarity) is the
fast path. A race between the two is caught as a `P2002` and attached to the
winning row instead of crashing the scan. Verified by `tests/pipeline.test.ts`,
including a row planted outside the candidate window so only the database
constraint can catch it.

**4.2 Two-layer discovery (cost control).** Stage A (`provider.screen()`) runs
first and is cheap; only a candidate reaches the FULL analysis. A screened-out
post is **archived, not deleted**, with the screen's confidence, reason and
prompt version in `ai_analyses` — the owner can overturn the call. A screen
failure never costs a lead: it is logged as a note and the full analysis runs.
Manual entries skip the screen deliberately (the owner pasted the post).

**4.3 Bounded, classified failure.** Adapters, the AI layer and the job each
retry only what is retryable and classify what went wrong (`rateLimited`,
`timeout`, `auth`, `http`, `network`, `parse`). The daily AI ceiling is rethrown
out of the pipeline so the runner stops the scan rather than failing once per
remaining post. One failing adapter never loses what another adapter found.

## 5. Concurrency model

There is no daemon, no queue and no in-process timer. The unit of work is one
short-lived process holding one lease:

```
BEGIN                    INSERT INTO job_locks … ON CONFLICT (id) DO UPDATE
                         SET locked_by = …, locked_until = …, updated_at = …
                         WHERE job_locks.locked_until < <application clock>
                         RETURNING id;                 -- empty ⇒ someone holds it
   … scan, write leads, write ScanRun + ScanSourceResult …
finally                  DELETE FROM job_locks WHERE id = 'hunt' AND locked_by = <this run>
```

Both sides of the comparison come from the application clock on purpose: the
`locked_until` column is a naive timestamp, and comparing it against the
database's `NOW()` silently ignored a live lease during development (the server
timezone offset made `NOW()` look hours in the future). The lease expires
(`HUNT_LOCK_MINUTES`, default 60), so a killed process cannot block discovery
forever.

## 6. Where to add the next source

1. Implement `SourceAdapter` (`search`, optional `healthCheck`) — read-only, no
   database access, an injectable `fetch` and a bounded timeout.
2. Register it in `registry.ts`, gated on its credentials.
3. Add the kind to `SourceKind` if it is a new platform, and to
   `src/i18n/{en,ru}.ts` (the dictionary is typed, so a missing label is a
   compile error).
4. Add offline contract tests (request shape, mapping, failure classes) as in
   `tests/perplexity.test.ts`.

Nothing else changes: the runner matches a query's source to an adapter by name,
and the pipeline is source-agnostic.
