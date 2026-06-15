---
id: FG-121
type: story
status: done
title: "Bedrock auth: env-snapshot via aws configure export-credentials"
---

**Closed:** 2026-05-13. Commit `8e7306c`.

**What landed:**
- `src/util/creds.ts` — new `exportAwsCreds(profile)` calls `aws configure export-credentials --profile <p> --format env-no-export` on the host and returns the parsed STS env vars. `FORGE_AWS_CREDS_FOR_TEST` escape hatch for unit tests.
- `src/spine/spawn.ts` — bedrock branch now defaults to env-snapshot: pass `CLAUDE_CODE_USE_BEDROCK=1` + `AWS_REGION` + STS env vars; drop the `~/.aws` mount + `AWS_PROFILE`. `FORGE_AUTH_MODE=mount` reverts to legacy mount-mode as escape hatch.
- Tests updated to assert env-snapshot is default, mount-mode falls back when toggled.

**Why this landed earlier than the BACKLOG planned (v2/#116):** during the first #128 validation run on 2026-05-13, the bedrock-mode container hit `ExpiredToken` even with a freshly-derived STS cache visible inside the container (mtime current, expiry 8h out, file readable). Host-side `aws sts get-caller-identity` succeeded against the same on-disk state at the same instant. Empirically proved the failure-shape #121 described: the container's AWS SDK derivation chain doesn't reproduce the host's. Implementing the env-snapshot path unblocked the run.

**Decision locked:** env-snapshot becomes the default. Mount mode is opt-in via `FORGE_AUTH_MODE=mount` for genuinely long-running containers (>1h, where the 1-hour STS TTL would expire mid-run). FORGE-DEC-013 is overturned in practice; its rationale (STS expiry mid-run) is mitigated by Jeff & Terry's pattern in their 8+ production projects and by the fact that forge tasks typically finish in minutes, not hours.

**Validation:** 355/355 tests pass. The second-attempt #127 forge run completed all phases (architect → plan → build → 5 reds → verify) using env-snapshot auth without further auth incidents. (One red, red-security, starved on what looked like Bedrock concurrent-request limits — separate concern, not auth.)

**Composite:** #117, #118, #119, #120 — these tactical mount-mode diagnostics remain useful only while mount mode exists. Under env-snapshot default, the failure modes they address (watchdog wrong profile, no log, manual `aws sso login` leaves STS stale, shallow auth status) become moot for the common path. Worth revisiting whether they're still worth fixing post-#121.