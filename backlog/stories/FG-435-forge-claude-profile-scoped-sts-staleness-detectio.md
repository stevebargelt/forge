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
- 2026-07-07 work-laptop recurrence: `aws sts get-caller-identity --profile adx-dev` and `aws configure export-credentials --profile adx-dev --format env-no-export` succeeded, but `forge claude --bedrock --aws-profile adx-dev` still hard-blocked on "AWS STS credentials are stale" until the operator manually touched `~/.aws/cli/cache/*.json` to satisfy the mtime heuristic. That proves the AWS chain was usable and Forge's mtime check was the blocker.
- 2026-07-07 multi-profile recurrence while launching the orchestrator: the operator was logged into one AWS profile and AWS CLI calls still worked from cached credentials, but Forge refused because the resolved `adx-dev` SSO token file had expired a few minutes earlier. That is a valid refusal ONLY if the launch is actually going to use `adx-dev`; otherwise it is another wrong-profile/preflight mismatch. The error must make the resolved profile explicit and the implementation must prove the resolved profile's real credential chain is unusable before blocking.
- 2026-07-07 correction to the above: the operator had refreshed `adx-dev` about 10 minutes earlier. The orchestrator still claimed the SSO token "had expired at 2026-07-07T23:35:21Z" even though that wall-clock time had not occurred locally; the claim likely confused UTC (`Z`) with local time, selected an old/wrong cache file, or inferred SSO expiration from an STS-cache mismatch. Forge must not narrate "SSO expired" unless it can show the exact resolved profile/session/cache file and timestamp interpretation supporting that conclusion.

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
- `forge claude --bedrock --aws-profile <p>` must not hard-block on the stale-cache mtime heuristic when `aws configure export-credentials --profile <p> --format env-no-export` succeeds. A successful export-credentials probe is authoritative for launch readiness because it is the same credential path Forge uses for container env-snapshot injection; any mtime stale finding after that is advisory only.
- `forge claude` must make the resolved profile explicit in both diagnosis and remediation. If the active shell has multiple AWS profiles/caches, the preflight must not treat "some profile is logged in" as proof that the resolved profile is ready, and must not treat "some other profile is expired/stale" as proof that the resolved profile is broken.
- When the resolved profile's SSO session appears expired but `aws configure export-credentials --profile <resolvedProfile> --format env-no-export` succeeds, Forge must allow launch. When that export fails because the resolved profile's SSO session is actually expired, the hard-block message must name that resolved profile and recommend `aws sso login --profile <resolvedProfile>` before retrying.
- Any SSO/STS expiry timestamp shown to the operator must include timezone context. If the cache stores UTC (`Z`), either render it as UTC explicitly or convert it to local time with the zone. Do not describe a token as expired by treating a UTC timestamp as local wall time.
- When Forge reports an expired SSO session, the diagnostic must identify the resolved profile and the evidence used for the claim: the sso_session / startUrl mapping, the cache file or cache-file hash if available, the raw `expiresAt`, the interpreted timestamp, and current time basis. If that evidence cannot be associated confidently with the resolved profile, do not hard-block on the cache claim.
- A recent successful `aws sso login --profile <resolvedProfile>` followed by successful `aws configure export-credentials --profile <resolvedProfile> --format env-no-export` must be treated as launch-ready regardless of stale-looking cache mtimes or old cache files. Cache heuristics are advisory in that case.
- The operator remediation must not require manual cache timestamp manipulation (`touch ~/.aws/cli/cache/*.json`) or hand-editing/removing AWS cache files when the profile's real credential export succeeds.
- Unit tests cover: profile-scoped stale, profile-scoped fresh, cross-profile isolation, SSO-only profile with no profile-associated cli/cache -> not-stale/non-blocking, unresolvable mapping safe-degrade, and preservation of existing FG-119/FG-120 single-profile stale detection behavior where profile association is clear.
- Tests cover the work-laptop recurrence: SSO cache mtime newer than STS cache mtime, but `export-credentials` succeeds for the resolved profile -> `forge claude` preflight allows launch and surfaces at most an advisory warning.
- Tests cover timestamp handling: a UTC `expiresAt` value is not reported as expired unless it is earlier than the actual current instant after timezone-correct parsing, and operator text includes timezone context.

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
