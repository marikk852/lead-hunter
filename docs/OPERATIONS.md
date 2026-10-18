# Lead Hunter — operations

How to run discovery, schedule it, read what happened, and recover when a source
misbehaves. Architecture: [ARCHITECTURE.md](ARCHITECTURE.md). Requirements:
[SPEC.md](SPEC.md).

---

## 1. Daily commands

```bash
npm run dev                       # the console (http://localhost:3000)
npm run hunt -- --dry-run         # what a scan would find; writes nothing
npm run hunt                      # real scan: discover → screen → analyse → score
npm run hunt -- --health          # can each configured adapter talk out?
npm run ai:check                  # one real model call, verifies the active key
npm run typecheck && npm test && npm run lint
```

`npm run hunt` writes a `scan_runs` row and one `scan_source_results` row per
adapter search, even when nothing is found. A dry run writes nothing and takes
no lock.

Exit codes: `0` fine (including "another scan is already running"), `1` the run
threw or every source failed, `2` the run stopped at `AI_DAILY_CALL_LIMIT`.

## 2. Scheduled discovery

Cron and launchd both work; pick whichever the machine already uses. The point
is that the scan is a one-shot process — there is no daemon to keep alive.

### cron (Linux, and macOS if you prefer it)

```bash
crontab -e
# every 30 minutes; the wrapper fixes PATH/cwd and appends a log
*/30 * * * * /absolute/path/to/scripts/hunt-cron.sh >> /absolute/path/to/logs/hunt.log 2>&1
```

### launchd (macOS)

Create `~/Library/LaunchAgents/com.lead-hunter.hunt.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.lead-hunter.hunt</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/scripts/hunt-cron.sh</string>
  </array>
  <key>WorkingDirectory</key><string>/absolute/path/to</string>
  <key>StartInterval</key><integer>1800</integer>
  <key>StandardOutPath</key><string>/absolute/path/to/logs/hunt.log</string>
  <key>StandardErrorPath</key><string>/absolute/path/to/logs/hunt.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.lead-hunter.hunt.plist
launchctl start com.lead-hunter.hunt        # run one now
launchctl unload ~/Library/LaunchAgents/com.lead-hunter.hunt.plist
```

### Guarantees the scheduler relies on

- **No overlap.** One run at a time, enforced by the `job_locks` lease. A second
  concurrent invocation logs "another scan is already running" and exits 0.
- **Crash recovery.** The lease expires after `HUNT_LOCK_MINUTES` (default 60),
  so a killed scan cannot block discovery forever.
- **No unbounded spend.** HTTP retries are capped with backoff; `AI_DAILY_CALL_LIMIT`
  stops model calls, and the run is recorded as `PARTIAL` with `stopped=budgetExceeded`.
- **Machine-off reality.** A local cron/launchd job does nothing while the
  computer is asleep. Accept it for a personal MVP; if it starts to matter, run
  the same one-shot command from a small always-on host (a VPS with the same
  `.env` and Postgres, or a scheduled task on an always-on machine). Nothing in
  the code needs to change — it is still one process taking one lease.

## 3. Reading a run

Settings → **Discovery runs** shows the last three runs with per-source rows.
The same information is in the database:

```sql
SELECT id, trigger, status, started_at, finished_at,
       queries_run, discovered, created, duplicates, failed, stopped, error
FROM scan_runs ORDER BY started_at DESC LIMIT 10;

SELECT r.started_at, s.adapter, s.status, s.items, s.query, s.message, s.duration_ms
FROM scan_source_results s JOIN scan_runs r ON r.id = s.run_id
ORDER BY s.created_at DESC LIMIT 20;

SELECT adapter, name, last_scan_at, health FROM sources ORDER BY adapter, name;
```

Status meanings:

| Status | Means |
| --- | --- |
| `OK` | The adapter answered and returned items. |
| `EMPTY` | The adapter answered and found nothing. **Not** a failure. |
| `ERROR` | The adapter failed; `message` holds the classified reason. |
| `SKIPPED` | No configured adapter serves that query's source (e.g. a query whose kind has no adapter, or a disabled source). |
| run `SUCCEEDED` | Finished with no source or item errors. |
| run `PARTIAL` | Finished, but at least one source failed or the AI budget stopped it. |
| run `FAILED` | Threw; `error` holds the message. |

## 4. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `reddit: FAIL [auth] … 403` | Reddit blocks unauthenticated programmatic search now. | Create a free "script" app at https://www.reddit.com/prefs/apps and set `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET`, then `npm run hunt -- --health`. |
| `[rateLimited]` on several queries | Too many requests, or the daily Reddit quota is spent. | Nothing to fix: the adapter backs off and honours `Retry-After`. Increase the cron interval if it is chronic. |
| `perplexity … skipped` | No `PERPLEXITY_API_KEY` — the adapter is not registered, so a `PERPLEXITY` query is reported as `SKIPPED`. | Set the key (paid per request) or delete/disable those queries. |
| Run `PARTIAL` with `stopped=budgetExceeded` | `AI_DAILY_CALL_LIMIT` reached. | Raise it, or wait for the next day. Rule-based runs are free and never counted. |
| `another scan is already running` but nothing is running | A previous process died mid-run and the lease has not expired. | Wait for `HUNT_LOCK_MINUTES`, or clear it deliberately: `DELETE FROM job_locks WHERE id = 'hunt';` |
| A lead is `SKIPPED` / `ARCHIVED` with a screen reason | Stage A rejected it as noise. | Open the lead and press **Re-analyze** — re-analysis skips the screen by design, so the full analysis runs. |
| Model calls fail but leads still appear | Expected: the lead is stored first, then analysed; a failure is recorded as `analysisStatus=FAILED`. | Check Settings → Key health, then **Re-analyze** the affected leads. |

## 5. Backups and retention

- Back up the database, not the app:

  ```bash
  pg_dump "$DATABASE_URL" > "backup-$(date -u +%Y%m%d).sql"
  ```

- `.env` holds the only copy of the AI/source keys; keep it out of git (it is
  ignored) and back it up separately.
- There is **no automatic retention policy yet**. `lead_events`, `ai_analyses`
  and `scan_source_results` grow monotonically. A manual cleanup is safe, since
  every one of them is derived history, not source data — keep the leads:

  ```sql
  DELETE FROM scan_source_results WHERE created_at < NOW() - INTERVAL '90 days';
  DELETE FROM scan_runs          WHERE created_at < NOW() - INTERVAL '365 days';
  ```

  (Settings already prunes AI key-health history to the newest 50 probes.)

## 6. Security posture in one paragraph

Single owner, local-first. Secrets live in `.env` and are never rendered back;
server actions all re-check the session; nothing is ever sent to a lead
automatically. The full threat model, including what is deliberately *not*
protected, is in [SECURITY.md](SECURITY.md).
