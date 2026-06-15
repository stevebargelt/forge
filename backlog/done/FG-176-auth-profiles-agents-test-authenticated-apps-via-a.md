---
id: FG-176
type: story
status: done
title: "Auth profiles: agents test authenticated apps via a captured browser session (CDP), never credentials"
---

**Closed:** 2026-05-29.

**Priority: high / soon — blocks QA of any authenticated app.** Today forge's browser agents (manual-qa, engineer/frontend visual verification) can only exercise *unauthenticated* surfaces. The implementer seeds already name this gap ("if the app requires authentication, check CLAUDE.md for a dev-auth path; if none, note it as a gap"). Without a systematic mechanism we either hand agents credentials (violates forge's no-secrets-to-agents posture) or skip authed flows entirely — and most real apps are behind a login.

**Principle:** agents operate *authenticated* but never *know credentials*. This is forge's existing trust model (read-only project mounts, container boundary as the trust line) generalized from the project to the app-under-test. The agent gets an authenticated browser context, not the secret.

**Concept — auth profiles.** A named profile binds a captured browser session to a set of domains:

```
auth_profiles:
  qa-admin:
    kind: browser-storage-state        # storageState-shaped JSON, loaded via CDP (NOT Playwright)
    path: ~/.forge/auth/qa-admin.storage.json
    domains: [ "https://staging.example.com" ]
    readonly: true
```

Task requests it: `forge invoke manual-qa --auth-profile qa-admin ...`. Forge copies the state into the authed task's container tmp, the CDP browser-tools start with cookies/localStorage already injected, and the path + contents are redacted from prompts and logs.

**Flow:**
1. Out-of-band trusted login: `forge auth-profile login qa-admin --url https://staging...` opens a real/controlled browser; the human logs in (incl. MFA).
2. Forge captures the session to a storageState-shaped JSON at the host-global path.
3. Later, `forge invoke ... --auth-profile qa-admin` injects it; the app sees the agent as logged in.
4. The prompt says "use auth profile qa-admin," never the password or cookie contents.

**Three load-bearing constraints (where the naive version breaks or leaks):**
- **CDP, not Playwright.** Forge retired Playwright for CDP browser-tools (#126, #128). Keep the storageState *format* but implement a CDP loader: cookies via `Network.setCookies`, localStorage/sessionStorage via `Page.addScriptToEvaluateOnNewDocument` per origin. Do not reintroduce Playwright. **Scope note:** "no Playwright" applies ONLY to the *agent's* injection path (browser-tools / manual-qa). The *project's* committed E2E suite IS Playwright (#177) and consumes this same storageState file *natively* via `storageState:` — same artifact, different consumer. Don't read this as "projects shouldn't use Playwright."
- **The state file is a bearer credential — store it host-global, never in the project tree.** Session cookies are live tokens. A path under `<project>/.forge/auth/` is readable by ANY agent via the project mount (read-only still means readable), defeating the principle. Store at `~/.forge/auth/<profile>.storage.json` (like runtimes), mode 600, gitignored, copied only into the specific authed task's container tmp — never via the general project mount. Encryption-at-rest is the trigger to activate #60 (`pass`).
- **Fail fast on expiry.** An expired session silently lands the agent on a login page, producing false bug reports ("app broken — shows login"). The profile must carry/derive expiry; `forge auth-profile status` checks it; the authed task fails fast ("profile qa-admin expired — re-run forge auth-profile login qa-admin") rather than proceeding logged-out.

**Smaller notes:**
- Name it distinct from `forge auth` (Claude API auth modes: bedrock/oauth/apikey). This is app-under-test auth, an orthogonal axis. `--auth-profile` is fine.
- `domains:` allowlist — inject state only for matching origins so staging cookies don't ride along to other hosts the agent navigates to.
- Redact profile path + contents from prompts, result.json, and container logs.

**Variant scoping:**
- v1 (build first): manual login + CDP capture/inject. No app changes, fits today.
- v2: scripted login using a vault secret -> activates #60.
- Preferred when available: app test-login endpoint (`/__test__/login?role=admin`) — deterministic, no UI login; recommend to app teams that can add it.
- Defer: magic-link / short-lived-token broker.
- Out of scope (for now): mobile — RN verification is tests-only, no browser/sim in container today.

**CLI surface:** `forge auth-profile login <name> --url <url>`, `forge auth-profile status [<name>]`, `forge auth-profile list`, `forge auth-profile rm <name>`; `--auth-profile <name>` on `forge invoke` and on pipeline steps that browser-verify.

**Schema:** new `auth_profiles` map (host-global and/or project `.forge/`), profile = {kind, path, domains[], readonly}. Resolve like runtimes (project override -> host-global fallback).

**Ties:** activates #60 (secret-at-rest); turns the implementer-seed dev-auth-gap note into a real mechanism; must respect the red read-only-mount rule (don't expose the cred via mounts); builds on this session's browser-verification hardening (ceda17d).