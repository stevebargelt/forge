---
id: FG-120
type: story
status: done
title: "`forge auth status` is shallow + the underlying health probe is local-clock-only"
---

**Closed:** 2026-05-26. (a) CLI now consumes `getAuthState()` (full profile/account/role/region/SSO portal/expiry/watchdog status); (b) `--deep` flag runs `aws sts get-caller-identity` for the honest answer. STS-cache-stale (#119) surfaced as a warning in the status output.

**Why:** Caught 2026-05-13 during diagnosis of #119. `forge auth status` for bedrock mode prints only `Auth mode: bedrock` + `AWS_REGION: us-east-1` — no SSO expiry, no STS cache state, no actual probe of whether the chain works. **Two bugs underneath:**

1. **CLI doesn't call the existing `getAuthState()` probe.** `src/cli/commands/auth.ts:103-128` reads `process.env.CLAUDE_CODE_USE_BEDROCK` and stops. The richer probe (`src/util/creds.ts:514` `getAuthState()`) checks SSO session expiry, parses the profile, returns `health: ok|expired|missing` + a `remediation` string. The dashboard's auth indicator (#97) uses it. The CLI doesn't. One-line fix: replace the dumb printing in `auth.ts:103-128` with a call to `getAuthState()` and a structured print of its fields.

2. **`getAuthState()` itself only checks the local clock**, not whether the credentials actually work. The bedrock branch (`creds.ts:516-542`) reads `~/.aws/sso/cache/*.json`, extracts `expiresAt`, returns `health: ok` if not clock-expired. That misses the failure mode from #119: AWS revokes the credential chain server-side when a new SSO session is minted; the old token's expiresAt is still in the future, so the probe says "ok" while STS returns 403.

**How to apply:**
- **#120a (small):** wire `auth.ts status` to `getAuthState()`. Print mode + health + identity + remediation + expiresAt + watchdog status + STS cache mtime. Cheap, makes the CLI useful immediately, doesn't fix the deeper probe gap but at least surfaces what we know.
- **#120b (bigger):** make `getAuthState()` actually exercise the chain when called explicitly. Two options:
  - (i) Call `aws sts get-caller-identity --profile <p>` as part of the probe. Adds ~500ms but is the only way to know whether the chain works. Probably too expensive for the dashboard's frequent-poll path; gate behind an explicit `--deep` flag or only run in the CLI's `status` command.
  - (ii) Compare STS cache mtime against SSO session token mtime. If SSO session is newer, the STS cache is stale (per #119's diagnosis). Doesn't catch *all* failure modes but catches the common one without hitting AWS.

Lean (i) for the CLI's `status` command (run once, user-initiated, the cost is acceptable). Lean (ii) for the dashboard's polled indicator (cheap, catches the common case).

**Composite with #117 / #118 / #119:** all four are auth-failure failure modes. #117 (wrong watchdog profile) prevents prevention; #118 (no log) hides the evidence; #119 (manual SSO leaves STS cache stale) is the runtime symptom; #120 is "forge can't even tell you what's wrong." Fix all four and the SSO auth path becomes honest.

**Caught:** 2026-05-13 — alongside #117/#118/#119 in same diagnosis session.