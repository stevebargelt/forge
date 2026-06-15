---
id: FG-79
type: story
status: done
title: Auto-detect bedrock + pre-flight check
---

**Closed:** 2026-05-11/12 across `f3d2d76`, `8f1c464`, `7ab5231`. Shipped:
- `detectCredsMode()` auto-detects bedrock when AWS_PROFILE is set or when `~/.aws/config` has SSO configured for the active profile. `CLAUDE_CODE_USE_BEDROCK=0` is the hard-off override.
- Pre-flight validation at both `forge new` and `forge next` — bedrock SSO cache freshness check, apikey env-var presence check. Dashboard's POST routes auth errors via `AUTH_ERROR_PREFIX` to a 400 toast, not a generic 500.
- New helpers: `resolveAwsProfile()` (defaults to "default"), `resolveAwsRegion()` (defaults to us-east-1), `hasAwsSsoConfigured()`, `hasFreshSsoCache()`, `hasAnyAwsSsoProfile()`.
- 19+ new tests in `creds.test.ts` covering every detector branch.