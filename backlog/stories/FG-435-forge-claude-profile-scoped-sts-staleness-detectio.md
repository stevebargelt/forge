---
id: FG-435
type: story
status: active
title: "forge claude: profile-scoped STS staleness detection + profile-named message (fix global-detection false positives)"
created: 2026-07-02
---

## Problem

detectStaleStsCache (src/util/creds.ts:763) compares the freshest mtime across ALL profiles' SSO session caches (~/.aws/sso/cache) against the freshest across ALL profiles' STS caches (~/.aws/cli/cache) — it is NOT scoped to the resolved profile. The `forge claude` preflight (src/cli/commands/claude.ts:84-91) then blocks launch, naming resolvedProfile only in the "Run:" remediation line while the diagnosis ("predates the current SSO session") silently refers to whichever profile's SSO session is globally freshest.

The same stale detector is also used by other auth/preflight surfaces, including validateCredsForNewRun() and forge auth status. Any blocking/preflight caller that can resolve the target AWS profile must avoid reintroducing global cross-profile false positives.

Consequences (both observed on a real multi-profile work laptop):

- Multi-profile false positive: recent activity on profile adx-dev (fresh SSO) makes its session the global "current" one; the check flags stale and tells the operator to refresh adx-dev-poweruser, but nothing conveys WHICH profile is actually stale or why. The operator ran the STS refresh against the wrong (working) profile and it did nothing.
- Pure-SSO-profile false positive: a profile authenticating via SSO-direct that never populates ~/.aws/cli/cache has a vestigial/stale cli/cache by construction, so SSO is permanently newer than STS -> permanent false "stale," with no bypass flag. Running `forge claude` sessions on the same machine authenticate fine (bedrock reads the SSO cache directly per FORGE-DEC-013), proving the creds are valid.

There is no env/flag bypass for the preflight; the only current workaround is deleting ~/.aws/cli/cache or manually refreshing the exact resolved profile.

## Goal

Scope STS-staleness detection to the RESOLVED profile and make the message accurate and profile-specific, so blocking preflight fires only for the profile actually being launched and tells the operator exactly which profile to refresh.

## Acceptance Criteria

- The stale detector accepts an explicit resolved profile, e.g. `detectStaleStsCache({ configDir, profile })`. Any caller that can resolve a profile must pass it.
- `forge claude`, `validateCredsForNewRun`, and `forge auth status` do not call the stale detector in a way that reintroduces global cross-profile false positives.
- detectStaleStsCache resolves the SSO session backing the resolved profile (parse ~/.aws/config for the profile's sso_session / sso_start_url mapping to its sso/cache token file) and compares only that session's cache against STS cache evidence confidently associated with that same profile. It must not compare global freshest SSO vs global freshest STS for blocking decisions.
- Fresh SSO activity on a DIFFERENT profile does not produce a stale verdict for the resolved profile. Regression test: profile A has a fresh SSO session, profile B is being launched -> B is judged on B's own caches only.
- A profile that uses SSO-direct and has no confidently-associated cli/cache entry of its own is NOT flagged stale (no vestigial-cache false positive) -> returns not-stale or advisory/non-blocking.
- If the profile -> sso_session mapping or profile-specific STS cache association cannot be resolved confidently, the check degrades safely: do NOT hard-block. Prefer not-stale with an advisory/fallback reason over introducing a new false positive.
- Legacy/global freshest-cache behavior is not used for blocking decisions. If retained for diagnostics, it must be non-blocking and clearly labeled as global/advisory.
- When genuinely stale (the resolved profile's own STS cache predates its own SSO session), the message names the profile in the DIAGNOSIS line (not just the Run: line) and states other profiles are unaffected, e.g. "STS credentials for profile '<p>' are stale — its cached STS creds predate its current SSO session (other profiles are unaffected). Refresh: aws sts get-caller-identity --profile <p>".
- Unit tests cover: profile-scoped stale, profile-scoped fresh, cross-profile isolation, SSO-only profile with no profile-associated cli/cache -> not-stale/non-blocking, unresolvable mapping safe-degrade, and preservation of existing FG-119/FG-120 single-profile stale detection behavior where profile association is clear.

## Non-Goals

- Does not require a live AWS call in normal `forge claude` preflight.
- Does not make dashboard polling perform expensive deep auth probes.
- Does not solve every possible AWS CLI cache format; when profile association is uncertain, fail open/non-blocking rather than blocking on a guess.

## Refs

- src/util/creds.ts:763 detectStaleStsCache, freshestSessionMtime / freshestFileMtime
- src/cli/commands/claude.ts:84-91 preflight + message
- src/util/creds.ts validateCredsForNewRun
- src/cli/commands/auth.ts forge auth status stale-cache display
- FORGE-DEC-013 (bedrock reads SSO cache directly; STS env not snapshotted)
- Lineage: FG-119 (manual aws sso login invalidates STS cache but forge does not notice), FG-120 (forge auth status shallow / local-clock-only)