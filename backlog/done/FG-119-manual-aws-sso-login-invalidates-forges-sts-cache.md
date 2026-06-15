---
id: FG-119
type: story
status: done
title: Manual `aws sso login` invalidates forge's STS cache but forge doesn't notice
---

**Closed:** 2026-05-26. `detectStaleStsCache()` compares freshest SSO-session-cache mtime against freshest STS-cli-cache mtime; if SSO is newer (the typical manual-login-revoked-prior-STS shape), it returns a stale warning with the `aws sts get-caller-identity` remediation. Wired into both `validateCredsForNewRun()` (fails pre-spawn instead of letting the agent burn on a 403) and `forge auth status` (shown as a ⚠ warning). 7 tests added.

**Why:** Caught 2026-05-13. Failure mode: SSO session aged out overnight (watchdog wasn't refreshing per #117), Steven did `aws sso login --profile adx-dev` manually at 06:33 PDT. New SSO session minted. But `~/.aws/cli/cache/<hash>.json` still held STS credentials derived from the *old* SSO session — clock-valid (`Expiration: 2026-05-13T19:12:27Z`) but actually revoked by AWS the moment the new session was created. Container at 06:34 read the stale-but-clock-valid STS creds, sent them to Bedrock, got 403 "security token expired" on the first request and every retry. The container itself can't refresh — `~/.aws` is mounted read-only.

**How to apply:** Three layers worth considering:
1. **Pre-flight check in `forge new` / `forge next`:** beyond the existing #79 SSO-expiry check, verify the STS cache's underlying SSO session is the *current* one. Compare STS cache file mtime against SSO session token mtime: if SSO is newer, the STS cache is stale. Either fail the pre-flight with a clear message ("STS cache stale — run `aws sts get-caller-identity --profile $AWS_PROFILE` then retry") or auto-trigger STS re-derivation by calling that command from forge itself before spawn.
2. **Document the gotcha in `forge auth status`:** if mismatch detected, surface it: "⚠ STS cache predates current SSO session — derive fresh creds with `aws sts get-caller-identity --profile $AWS_PROFILE`."
3. **Container-side detection:** the agent gets 403 on first call; the agent could re-read the STS cache (still won't help since :ro mount), or forge could detect 403-on-first-call in container.stdout and surface it differently from "the agent itself errored" — currently the task just fails with no signal to the human that it was an auth-stale issue, not an agent issue.

Lean (1) + (2). The container can't fix this from inside; forge has to either catch it pre-spawn or guide the human to fix it pre-spawn.

**Composite with #117 + #118:** all three are SSO/STS auth-failure failure modes. #117 prevents the watchdog from doing its job; #118 hides the evidence; #119 is what happens when the human manually papers over the gap. Fixing #117 + #118 reduces how often #119 fires; fixing #119 makes the auth-stale state recoverable without container failure.

**Caught:** 2026-05-13 — root-cause analysis of why task-plan-7acda2 failed despite a fresh `aws sso login`.