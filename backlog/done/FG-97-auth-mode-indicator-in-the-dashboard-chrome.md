---
id: FG-97
type: story
status: done
title: Auth-mode indicator in the dashboard chrome
---

**Closed:** 2026-05-11/12 across `0c58d65`, `5d4580e`, `d92c32f`, `81e0193`, `0748752`, `73b0bb8`, `2c1e6b4`, `487da9f`, `c39643c`. Shipped:
- Read-only indicator under the FORGE wordmark in the sidebar. Single line of geist-mono: `● {mode} · {identity}` with the dot color-coded by health (green/amber/red).
- Click opens a popover with mode-specific detail. Bedrock shows profile, account, role, region, SSO portal, token expiry + remaining time, watchdog status. OAuth shows account email, organization, plan tier, login date (sourced from a host-side hint cache populated by `forge auth login`). Apikey is intentionally bare — leaking key prefixes/suffixes was a security concern.
- Polled every 60s; SSO-expires-mid-session auto-surfaces without a dashboard restart.
- AWS_PROFILE env var alone now triggers bedrock auto-detect (no need to set CLAUDE_CODE_USE_BEDROCK=1). Migrated the OAuth volume mount from `/home/agent/.claude` to `/home/agent` so `.claude.json` (account info) is captured alongside `.credentials.json` (token); volume name bumped to `forge-claude-oauth-v2`.
- Async-loaded Google Fonts via media-swap so a blocked `fonts.googleapis.com` (corp proxies) doesn't freeze paint.