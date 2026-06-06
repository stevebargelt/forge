# Decision: pi OAuth auth mode — `forge pi login` + pre-seeded auth.json

**Date:** 2026-06-05
**Tickets:** #266 (pi OAuth auth seam), #258 (Pi epic). Auth proven by #296; the
TRUE completing-run proof is #300 (deferred).
**Status:** implemented + tested. **AUTH chain VALIDATED LIVE** (#296): `forge pi
login` (bare `/login` → select Claude Pro/Max → paste the failed localhost-callback
URL into pi's manual prompt) minted a real subscription credential, and a `forge
invoke --runtime pi-oauth` dispatch authenticated and reached `api.anthropic.com`
on the subscription. The #264 attribution surfaced the provider's response cleanly
(`pi run failed: 400 … out of extra usage`), not a bare `no_result_json`.

This is **not** an end-to-end "Crawl exit": the call was refused pre-generation
(the account's pay-as-you-go balance was $0), so **no task completed and no usage
row was written**. A real completing run + usage row is intentionally unfunded for
now and tracked as **#300 (deferred — needs paid extra credits or a free
provider)**. Do not describe the Pi Crawl as having a proven completing run until
#300 is satisfied.

## Why

The Crawl runtime `pi-apikey` (#261) authenticates pi via an env-var provider API
key. Many operators (including this one) have a Claude **subscription** (Pro/Max),
not an API key. pi supports subscription auth: its OAuth module speaks
`https://claude.ai/oauth/authorize` → `https://platform.claude.com/v1/oauth/token`
→ `https://api.anthropic.com` — the same flow Claude Code uses. (Also OpenAI/
ChatGPT and Copilot.) #266 wires that into forge.

## Two pieces

**1. `forge pi login` (minting).** pi is NOT installed on the host, so forge runs
pi's interactive `/login` inside a container (`forge pi login`), bind-mounting the
host dir `~/.forge/pi-agent` at the container's `PI_CODING_AGENT_DIR`. The user
runs `/login anthropic`, follows the OAuth URL (paste-the-code flow — no real
browser redirect needed), and pi writes `auth.json` straight to the host dir.
`FORGE_PI_DIR` overrides the parent dir (tests). This mirrors `forge auth login`
(claude OAuth volume) and `codex login`.

Note: the existing `forge-claude-oauth-v2` volume (Claude Code's OAuth) is NOT
reusable — different on-disk format. pi needs its own `forge pi login`.

**2. `auth.mode: pi-auth` (the run seam).** The `pi-oauth` runtime
(`seeds/runtimes/pi-oauth.yml`) RO-mounts ONLY `~/.forge/pi-agent/auth.json` at
`/forge-pi-auth/auth.json` (fail-loud if absent → "run forge pi login"). The
agent entrypoint copies it into a writable `PI_CODING_AGENT_DIR` (default
`/tmp/pi-agent`, mode 600) so pi can refresh its token in-container. Exactly the
codex-auth pattern. The invocation carries no `--api-key` — auth is the OAuth
token. `auth_strategy: pi-auth-json` in the #292 metadata.

## Expiry / refresh

- pi refreshes the (short-lived) access token in the **container's** writable
  copy, using the refresh token from the mounted `auth.json`. That refreshed copy
  **dies with the container** — the host `~/.forge/pi-agent/auth.json` is the
  source of truth and is never written from a task run (same as codex-auth).
- So every task container independently refreshes from the host's refresh token.
  This works as long as the host refresh token is valid.
- **Re-run `forge pi login` when:** the provider invalidates/rotates the refresh
  token (some providers rotate on use — the host copy wouldn't see the rotation),
  or you see auth failures in a pi run's stdout. This is the known limitation of
  the "host source of truth, container-ephemeral refresh" model; a future
  enhancement could write refreshed tokens back to the host (out of scope here).

## Out of scope

- Provider/profile binding so model-policy can SELECT pi-oauth (#265) — for now
  it's explicit: `forge invoke --runtime pi-oauth`.
- The live end-to-end run (#296). The seam is tested (mount built, fail-loud,
  entrypoint copy smoked); a real subscription-backed task awaits `forge pi login`.
