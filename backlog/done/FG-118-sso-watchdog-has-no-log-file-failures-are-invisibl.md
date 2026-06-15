---
id: FG-118
type: story
status: done
title: SSO watchdog has no log file; failures are invisible
---

**Closed:** 2026-05-26. Watchdog spawn now passes `[ignore, logFd, logFd]` instead of `'ignore'`; log lands at `~/.forge/sso-watchdog.log` (append-only — user rotates manually if it grows). New `forge auth watchdog-tail [-n N]` subcommand prints the path + tails the last N lines.

**Why:** Caught 2026-05-13 alongside #117. `src/util/sso-watchdog.ts:42` spawns the watchdog with `stdio: 'ignore'`. Any output the script produces (the `echo "[watchdog] ..."` lines for SSO-OK / refresh-attempt / refresh-failure) goes to `/dev/null`. When something goes wrong (wrong profile per #117, AWS CLI not installed, network blip), there's no on-disk record. Yesterday's #117 failure was undetectable until the container errored, which itself took hours.

**How to apply:** Redirect the watchdog's stdout+stderr to a log file at `~/.forge/sso-watchdog.log` (or one log per runId, rotating). Trade-offs:
- Single log: simpler; tail-able; old runs' entries linger
- Per-run log: cleaner audit per run; more files; harder to grep across history

Lean single log with a length cap (truncate-on-start or rotate at N MB). The script already prints timestamps, so a single log is grep-friendly.

Implementation: in `src/util/sso-watchdog.ts`, replace `stdio: 'ignore'` with `stdio: ['ignore', logFd, logFd]` where `logFd` is `openSync('~/.forge/sso-watchdog.log', 'a')`. Add a `forge auth watchdog-tail` CLI subcommand or similar so the user can read it without remembering the path.

**Caught:** 2026-05-13 — same diagnosis session as #117.