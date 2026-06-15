---
id: FG-117
type: story
status: done
title: SSO watchdog default profile is hardcoded and wrong for most setups
---

**Closed:** 2026-05-26. One-line fix in `scripts/run-sso-watchdog.sh`: `PROFILE="${SSO_WATCHDOG_PROFILE:-${AWS_PROFILE:-adx-dev-sso}}"`. Watchdog now inherits the user's already-set shell profile by default; the hardcoded fallback only kicks in when AWS_PROFILE isn't set.

**Why:** Caught 2026-05-13. `scripts/run-sso-watchdog.sh:33` defaults `SSO_WATCHDOG_PROFILE` to `adx-dev-sso`. Steven's actual setup uses `adx-dev` (the sso-session is named `adx-dev`, the profile is `adx-dev`, no `-sso` suffix anywhere). The watchdog has been running overnight (PID 64730, started May 12 20:20) but refreshing the wrong profile name — `aws sso login --profile adx-dev-sso` fails because that profile doesn't exist in `~/.aws/config`. Watchdog's `stdio: 'ignore'` in `src/util/sso-watchdog.ts:42` swallows the error output, so the failure was invisible.

**How to apply:** Two options worth weighing:
- (a) Default `SSO_WATCHDOG_PROFILE` to `${AWS_PROFILE:-adx-dev-sso}` in the script. Simplest — the watchdog inherits whatever the user's shell already set, falling back to today's default only when AWS_PROFILE is unset.
- (b) `src/util/sso-watchdog.ts` reads `process.env.AWS_PROFILE` at spawn time and passes it to the script as `SSO_WATCHDOG_PROFILE=<value>` in the child env. Marginally cleaner separation (script doesn't read env directly, forge controls the value).

Lean (a). Minimal change, matches how the user already authenticates, no schema change.

**Caught:** 2026-05-13 — diagnosing task-plan-7acda2 auth failure on the System Map (#105) run.