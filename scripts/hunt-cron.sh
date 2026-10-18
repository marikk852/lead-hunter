#!/usr/bin/env bash
#
# Scheduled discovery entry point for cron/launchd.
#
#   */30 * * * * /absolute/path/to/scripts/hunt-cron.sh >> /absolute/path/to/logs/hunt.log 2>&1
#
# Why a wrapper instead of `npm run hunt` directly: cron starts with a minimal
# PATH and an unrelated working directory, so node/npm may not be on PATH and the
# relative `.env` would not be found. This script fixes both, logs everything,
# and never runs two scans at once (the application takes a database lease; a
# concurrent invocation simply reports "already running" and exits 0).
#
# Exit codes: 0 success (including "already running"); 1 a run failed; 2 the run
# stopped at AI_DAILY_CALL_LIMIT. Anything non-zero other than 2 deserves a look.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

mkdir -p "$PROJECT_DIR/logs"

# Cron/PATH helpers: add common Node install locations if npm is not resolvable.
if ! command -v npm >/dev/null 2>&1; then
  for candidate in /opt/homebrew/bin /usr/local/bin "$HOME/.nvm/versions/node"/*/bin; do
    if [ -x "$candidate/npm" ]; then PATH="$candidate:$PATH"; fi
  done
  export PATH
fi

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) hunt start ==="
npm run --silent hunt -- --scheduled "$@"
status=$?
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) hunt end (exit $status) ==="
exit $status
