#!/usr/bin/env bash
# run-sso-watchdog.sh
#
# Origin: copied verbatim (with this header added) from Terry's workspace,
#   .workspace-scaffold/scripts/orchestration/multi-agent/run-sso-watchdog.sh
# Adapted for forge: profile default left as adx-dev-sso so users can override
# via SSO_WATCHDOG_PROFILE; otherwise unchanged.
#
# SSO session watchdog — runs on the host in the background and proactively
# renews the AWS SSO session before it expires. Designed to run alongside
# long forge runs (multi-phase reviews, fanouts, etc.).
#
# Usage:
#   bash run-sso-watchdog.sh &
#   WATCHDOG_PID=$!
#   # ... run forge ...
#   kill "$WATCHDOG_PID" 2>/dev/null
#
# Forge starts/stops this automatically via src/util/sso-watchdog.ts when
# FORGE_SSO_WATCHDOG points at this script.
#
# Env vars:
#   SSO_WATCHDOG_THRESHOLD_MIN  — refresh when SSO token has less than this many
#                                 minutes remaining (default: 60)
#   SSO_WATCHDOG_POLL_SEC       — poll interval in seconds (default: 300 = 5 min)
#   SSO_WATCHDOG_PROFILE        — SSO profile to refresh (default: adx-dev-sso)

set -euo pipefail

THRESHOLD_MIN="${SSO_WATCHDOG_THRESHOLD_MIN:-60}"
POLL_SEC="${SSO_WATCHDOG_POLL_SEC:-300}"
PROFILE="${SSO_WATCHDOG_PROFILE:-adx-dev-sso}"
PID_FILE="${TMPDIR:-/tmp}/sso-watchdog.pid"

echo $$ > "$PID_FILE"
echo "[watchdog] SSO watchdog started (PID $$) — threshold=${THRESHOLD_MIN}m poll=${POLL_SEC}s profile=$PROFILE"

# ── Helpers ───────────────────────────────────────────────────────────────────

_sso_min_remaining() {
    # Returns seconds remaining on the SSO access token.
    # Only checks files with 'accessToken' — ignores registration files.
    # Returns 0 if no valid token found.
    python3 - <<'PYEOF'
import json, glob, os
from datetime import datetime, timezone

cache_dir = os.path.expanduser("~/.aws/sso/cache")
min_remaining = None

for f in glob.glob(os.path.join(cache_dir, "*.json")):
    try:
        with open(f) as fh:
            d = json.load(fh)
        if "accessToken" not in d:
            continue  # skip registration files
        exp = d.get("expiresAt", "")
        if not exp:
            continue
        expiry = datetime.fromisoformat(exp.replace("Z", "+00:00"))
        remaining = (expiry - datetime.now(timezone.utc)).total_seconds()
        if min_remaining is None or remaining < min_remaining:
            min_remaining = remaining
    except Exception:
        pass

print(max(0, int(min_remaining)) if min_remaining is not None else 0)
PYEOF
}

# ── Main loop ─────────────────────────────────────────────────────────────────

while true; do
    remaining_secs=$(_sso_min_remaining)
    remaining_min=$(( remaining_secs / 60 ))
    threshold_secs=$(( THRESHOLD_MIN * 60 ))

    if [[ "$remaining_secs" -lt "$threshold_secs" ]]; then
        echo "[watchdog] $(date -u +%Y-%m-%dT%H:%M:%SZ) SSO expires in ${remaining_min}m — refreshing (profile: $PROFILE)"
        # Try silent refresh first: AWS CLI v2 uses the cached refreshToken to get
        # a new accessToken without opening a browser. Falls back to browser login
        # only if the refreshToken is also expired.
        if aws configure export-credentials --profile "$PROFILE" --format process > /dev/null 2>&1; then
            echo "[watchdog] SSO refreshed silently ✓"
        elif aws sso login --profile "$PROFILE" 2>&1; then
            echo "[watchdog] SSO refreshed via browser ✓"
        else
            echo "[watchdog] WARNING: SSO refresh failed — will retry in ${POLL_SEC}s" >&2
        fi
    else
        echo "[watchdog] $(date -u +%Y-%m-%dT%H:%M:%SZ) SSO OK — ${remaining_min}m remaining"
    fi

    sleep "$POLL_SEC"
done
