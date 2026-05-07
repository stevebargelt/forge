# Decision: Mount ~/.aws into bedrock containers, run a detached SSO watchdog on the host

**ID**: FORGE-DEC-013
**Date**: 2026-05-06
**Status**: Decided
**Decided by**: Steven (forge build, fixing real expiry-during-run failures)
**Supersedes**: N/A
**Scope**: forge

---

## Context

Forge agents run as ephemeral docker containers. In bedrock mode they call AWS Bedrock APIs from inside the container, which means each container needs valid AWS credentials at every Bedrock call.

The original design (pre-this-decision) snapshotted STS-style env vars (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) when the user sourced `use-bedrock.sh`. Those env vars were inherited by the forge process, then passed via `docker run -e ...` to each agent container.

That design has a hard ceiling: the SGWS organization's SSO sessions expire after **one hour**. Any forge run longer than ~60 minutes — codebase assessments, multi-phase feature workflows, anything with non-trivial assess/build phases — will start failing mid-run as the snapshotted creds go stale. Even if the user re-sources `use-bedrock.sh` in a new terminal, already-running containers still hold the stale env, and so does the forge process itself.

The vault's spine sketch anticipated this and described an "SSO watchdog" — Terry's `run-sso-watchdog.sh` — that polls SSO cache expiry every 5 minutes and refreshes silently via the SSO refresh token (or via interactive `aws sso login` as a fallback). Forge's v0 had a stub `sso-watchdog.ts` with start/stop hooks but no actual script wired up; nothing was ever refreshing.

The Claude Code CLI itself solves this for the user's interactive shell via the `awsAuthRefresh` setting that points at a credential-refresh script. That's not directly portable to forge — agent containers don't have access to host SSO state, can't pop a browser, and shouldn't race each other to refresh.

---

## Problem

**How should bedrock-mode agent containers stay authenticated across runs longer than the SSO session lifetime?**

Sub-problems:
1. How do containers see fresh creds without env-var snapshotting?
2. Where does the refresh actually happen — in-container or on the host?
3. How is the refresh process's lifecycle managed across multiple short forge invocations?

---

## Options Considered

### Option A: In-container refresh (rejected)

Mount `refresh_creds.sh` into the container; have the container run it on detected expiry.

**Cons (decisive)**:
- Containers have no display, no browser, no path to host browser.
- `aws sso login` from inside a container can only print a device-flow code with nowhere to enter it.
- SSO cache state lives on the host. Mounting it RW into containers is a credential-handling problem.
- Multiple parallel containers (fanout, reds) would race to refresh.

---

### Option B: On-demand refresh before each `docker run` (rejected)

Forge calls `refresh_creds.sh` (or equivalent) on the host before each spawn.

**Pros**: simple; one entry point; matches Claude Code's `awsAuthRefresh` pattern.

**Cons**:
- A long-running container (an assessor reading a large codebase for 60+ min in one container) gets fresh creds at start but goes stale during the run. Forge isn't doing more docker runs to re-trigger refresh — it's waiting on the existing one.
- Pauses each spawn while the script runs. Tolerable but adds 1–10 seconds to every dispatch.
- No coverage of idle periods (forge between phases, no spawning, but creds expire).

This option is *good defensive layering* — call it from `ensureCreds()` for safety — but inadequate as the only mechanism.

---

### Option C: Host-side watchdog + profile mount ✅

- **Watchdog** (Terry's `run-sso-watchdog.sh`, vendored into `scripts/`): polls every 5 minutes, refreshes silently via the cached SSO refresh token (no browser) when the access token has less than 60 minutes remaining, falls back to `aws sso login` (browser pop) only when the refresh token has also expired (rare; refresh tokens last days-to-weeks). Runs on the host so it has access to the browser, the SSO cache, and the AWS CLI.
- **Profile mount**: bedrock containers mount `~/.aws` read-only into `/home/agent/.aws` and set `AWS_PROFILE=<configured>`. The SDK inside the container reads SSO state from the mount on every Bedrock call, picking up whatever the host watchdog last refreshed.
- **Lifecycle**: forge starts the watchdog at the top of `forge next`. The watchdog runs **detached + unref()'d**, so it survives forge process exits between phases. PID is tracked in `~/.forge/sso-watchdog.pid`. Subsequent forge invocations check the PID file — if a watchdog is alive, no-op; if the PID file is stale (process gone), clean it up and start fresh. The watchdog is stopped explicitly when forge sees `run.status` become `complete`.

**Pros**:
- Containers always see fresh creds via the mount; no env-var staleness possible
- Refresh happens proactively during idle periods, not just at spawn
- Browser pops are rare (only when SSO refresh token expires) and happen on the host where the user is
- The watchdog is a single point of contention — no race between parallel containers
- Detached lifecycle handles the realistic forge usage pattern (multiple short `forge next` calls bracketing one logical run)

**Cons / Trade-offs**:
- Mounts `~/.aws` into agent containers — surface area larger than the env-var version. Mitigated by RO mount and the fact that agents never need to write AWS state.
- Detached watchdog can leak if the run crashes in a way that prevents clean stop. PID file + `isWatchdogRunning` check on next `forge next` makes this self-healing.
- Adds a script dependency (`run-sso-watchdog.sh` must be present). Forge fails-soft if not — `startSsoWatchdog` is a no-op when `FORGE_SSO_WATCHDOG` is unset or the script is missing.

---

## Decision

**Chose**: Option C — host-side detached watchdog + profile mount.

**Rationale**: Option A doesn't work in containers; Option B is necessary but insufficient. Option C is the architecture the spine sketch already described, with two adjustments forced by reality:

1. **Profile mount instead of env-var snapshot.** The sketch implied env-var passing because that's how the rest of forge handled mode-specific config. With one-hour SSO sessions, env-var snapshotting is fundamentally broken regardless of how good the watchdog is — by the time the second spawn happens, the env is already stale unless the parent forge process re-reads. Mounting cuts out that whole class of failure: the SDK reads live state every call.

2. **Detached lifecycle.** The original `sso-watchdog.ts` shim spawned the watchdog as a forge child process. That fails the moment forge exits between phases (which it does, every time). Detaching + PID-file tracking matches the actual usage pattern: one watchdog per logical run, lifetime independent of any single forge invocation.

We layer Option B (sync refresh in `ensureCreds` via `FORGE_CREDS_REFRESH`) as a defensive backstop — the watchdog should normally make this unnecessary, but if it ever fails to start, the synchronous refresh on `forge next` keeps the run from breaking.

---

## Consequences

**Positive**:
- Multi-hour runs against bedrock work without manual intervention
- Browser only pops when the SSO refresh token expires (days-weeks cadence), not when the access token expires (hourly)
- The watchdog auto-recovers from stale PID files (e.g. forge crash mid-run)
- Profile mount is symmetric with how Claude Code itself handles `~/.aws` — same mental model

**Negative / Trade-offs**:
- Bedrock mode now requires `aws configure sso` to be set up on the host. Acceptable — it's a hard prereq for Bedrock anywhere.
- The mounted `~/.aws` exposes more host state to agent containers than env-var passing did. RO mount limits the blast radius.
- A truly orphaned watchdog (forge killed `kill -9`, PID file present, process gone) is detected on next `forge next` via `kill -0` check; the stale file gets cleaned up and a fresh watchdog spawned. Worst case: a 5-minute window where neither the dead nor the new watchdog is refreshing.

**Risks**:
- If the user changes `AWS_PROFILE` mid-run, containers reading from the mount immediately see the new profile (no-restart-needed) — could be surprising. Fine in practice; users don't change profiles mid-run.
- If `~/.aws/credentials` has stale aws_access_key_id-style entries from a prior `refresh_creds.sh`-style flow, containers might prefer those over the SSO profile. Not a real risk for our usage — the profile we care about is SSO-based with no static creds.

---

## Implementation Notes

- `scripts/run-sso-watchdog.sh` — vendored from Terry's workspace with attribution. Verbatim except for a header noting origin. Defaults: 60-min threshold, 300-sec poll, profile from `SSO_WATCHDOG_PROFILE`.
- `src/util/sso-watchdog.ts` — start/stop/isRunning + private `_ssoWatchdogPidFile()` test seam. Spawns with `detached: true` + `unref()`. PID file at `~/.forge/sso-watchdog.pid` (overridable via `FORGE_HOME`).
- `src/spine/spawn.ts` — bedrock branch passes only `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_PROFILE`, `AWS_REGION`. Mounts `awsConfigDir()` (default `~/.aws`, override via `FORGE_AWS_DIR`) at `/home/agent/.aws:ro`.
- `src/util/creds.ts` — bedrock mode requires `AWS_PROFILE` (used to require `AWS_ACCESS_KEY_ID`). Validates `awsConfigDir()` exists; calls `FORGE_CREDS_REFRESH` if set as a defensive synchronous refresh.
- `scripts/use-bedrock.sh` — sets `AWS_PROFILE`, `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, `FORGE_SSO_WATCHDOG`, `SSO_WATCHDOG_PROFILE`. Drops the old `aws configure export-credentials --format env` snapshot.
- `forge next` calls `startSsoWatchdog(runId)` after reconcile. `forge next` calls `stopSsoWatchdog()` only when `run.status` is `complete` or `abandoned`, so the watchdog persists across phase boundaries.

Tests (in `src/util/sso-watchdog.test.ts`): isWatchdogRunning behaviors (no file, stale PID, live process), start/stop roundtrip with a real dummy script, idempotent start, graceful stop with no PID file, no-op when `FORGE_SSO_WATCHDOG` is unset or missing. In `src/spine/spawn.test.ts`: bedrock mode mounts `~/.aws` RO and sets `AWS_PROFILE`/`AWS_REGION`; doesn't pass STS env vars; oauth and apikey modes unchanged.

---

## Revisit Conditions

- If a workflow ever needs multiple AWS profiles in the same forge run (one assessor on `prod`, one on `staging`), the single-profile mount becomes wrong. Probably need per-spawn profile selection.
- If forge moves to a daemon model (long-lived process), the detached lifecycle becomes unnecessary; watchdog can be a child of the daemon directly.
- If AWS introduces shorter SSO refresh-token lifetimes (currently days-weeks), the "browser pop is rare" assumption weakens and we'd need richer UX around the interactive login (signal forge that it just popped, etc.).
- If we add a non-AWS credential-refresh case (e.g. GCP, on-prem, etc.), generalize the watchdog interface beyond `FORGE_SSO_WATCHDOG` naming.
