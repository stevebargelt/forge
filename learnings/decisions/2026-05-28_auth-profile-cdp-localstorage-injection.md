# Auth profiles: CDP localStorage injection is the load-bearing mechanism (#176 spike)

**Date:** 2026-05-28
**Status:** Slices 1–3 built & verified END-TO-END in a real agent container
**Ticket:** #176 (auth profiles)

## Outcome — read this first (2026-05-29)

**For routine authenticated E2E, do NOT use this capture-and-inject feature.**
Use **programmatic login** instead: a dedicated test user + the project's own
harness logging in fresh each run (e.g. Playwright `globalSetup` →
`signInWithPassword` → `storageState`). No human, no session expiry, no captured
token to manage, and the localhost↔host.docker.internal origin reconcile becomes
moot. The wnba-led-scoreboard web-admin E2E is the reference implementation.

This capture/inject feature (everything below) is the **narrow fallback** for
apps with **no scriptable login** — third-party SSO/MFA where you genuinely
can't mint a session programmatically. Principle either way: **forge never logs
in interactively** — a non-interactive auth script produces the storageState.
We built capture/inject first (it needed no app changes) before concluding the
programmatic path is the right default; this is recorded so the next reader
doesn't repeat that detour.

## Context

#176 lets forge browser agents test *authenticated* apps without ever holding
credentials: capture a browser session out-of-band, store it host-global, inject
it into the agent's CDP browser so the app-under-test sees the agent as logged in.
The whole epic rests on one unproven assumption — that a captured session can be
re-injected into the `:9222` CDP Chrome and actually authenticate the app. This
spike tested exactly that against a real Supabase app (the LED Scoreboard admin,
`localhost:3000`).

Spike code: `spikes/176-auth-cdp/inject-spike.mjs` (control-vs-treatment experiment
using `puppeteer-core` from the browser-tools skill, isolated incognito contexts).

## What we proved

Injecting captured localStorage via CDP `Page.addScriptToEvaluateOnNewDocument`
(Puppeteer `evaluateOnNewDocument`) **before** navigation flips a clean incognito
context from unauthenticated to fully authenticated. Treatment rendered the real
user's identity (`steve@bargelt.com`), device, and team data fetched from the
backend; the control (same URL, no injection) rendered an empty shell. The
Supabase client read the injected token at startup, validated it, and hydrated.

## Three findings that shape the build

1. **localStorage is the load-bearing path, not cookies.** This app stores its
   entire session in `localStorage` under `sb-<projectref>-auth-token` (~2.2KB JWT
   bundle) and uses **zero auth cookies** (`document.cookie` empty). So
   `Network.setCookies` is irrelevant *for Supabase-default apps* — the mechanism
   that matters is `addScriptToEvaluateOnNewDocument` firing at document-start.
   #176 should still support cookies generically (`@supabase/ssr` and other apps
   are cookie-based), but the localStorage path is mandatory and must come first.

2. **Expiry detection cannot rely on a login-URL bounce.** The unauthenticated
   app does **not** redirect to `/login` — it renders the same URL with empty
   placeholders (`?` avatar, `—`, no data). A "did we land on the login page?"
   heuristic would therefore never fire. `forge auth-profile status` and the
   fail-fast-on-expiry check **must parse the token's `expires_at`** from the
   captured storageState (the Supabase JWT bundle carries it), not watch the URL.
   This is the concrete reason behind #176's "profile must carry/derive expiry."

3. **`createBrowserContext()` (incognito) is the isolation primitive.** A clean
   context proves injection rather than reusing an already-authed window. The real
   browser-tools injector should apply state into the context the agent drives.

## Mechanism (reference for the real injector, lives in pi-skills/browser-tools)

```js
// register BEFORE navigation; fires at document-start for the matching origin
await page.evaluateOnNewDocument((origin, entries) => {
  if (location.origin !== origin) return;        // domains[] allowlist
  for (const { name, value } of entries) localStorage.setItem(name, value);
}, ORIGIN, localStorageEntries);
// cookies (when present): await page.setCookie(...cookies)  -> CDP Network.setCookies
await page.goto(deepUrl);
```

## storageState shape (what capture writes, what both consumers read)

```json
{ "cookies": [],
  "origins": [ { "origin": "http://localhost:3000",
                 "localStorage": [ { "name": "sb-...-auth-token", "value": "..." } ] } ] }
```

Playwright-storageState-compatible on purpose: the project's committed E2E suite
(#177) consumes this file natively via `storageState:`; the agent's browser-tools
consumes the same file via CDP injection. One artifact, two consumers, no shared
code path.

## Build status

- **Slice 1 — forge (done, commit 84deada):** `forge auth-profile {login,status,
  list,rm}`. login launches a dedicated Chrome, human logs in, raw-CDP snapshot →
  host-global `~/.forge/auth/<name>.storage.json` (mode 600). status/list parse
  `expires_at` (Supabase top-level, JWT exp fallback) to fail-fast on expiry.
  Verified end-to-end with a real Supabase login (qa-admin).
- **Slice 2 — pi-skills/browser-tools (done, live on disk; third-party repo, not
  committed there):** `auth-inject.js` `maybeApplyAuth(page)` — no-op unless
  `BROWSER_TOOLS_STORAGE_STATE` is set (generic, non-forge-branded — #182);
  registers the document-start localStorage script per
  origin + `setCookie`, logs SHAPE only. Wired into `browser-nav.js` before each
  nav. Verified against :9222 with the real qa-admin profile (control empty,
  treatment rendered steve@bargelt.com).
- **Slice 3 — forge (done):** `--auth-profile <name>` on `forge invoke`; `invoke.ts`
  resolves the profile and fails fast (no container) on missing/expired; `spawn.ts`
  mounts the file read-only at `/forge-auth/state.json` and sets
  `BROWSER_TOOLS_STORAGE_STATE`, and throws if browser-tools (the injector) isn't
  mounted. The token rides only a
  single read-only mount — never argv, prompts, result.json, or the project mount.
  Unit-tested (docker args + fail-fast).

## Real container run — PASSED (2026-05-28)

`forge invoke manual-qa --auth-profile qa-admin-docker --project .../wnba-led-scoreboard`
spawned a real agent container; the agent (which never saw the credential)
reported `logged_in: true`, `signed_in_email: steve@bargelt.com`,
`device_name_visible: steve-1`, `teams_visible: true`. Container stdout shows the
injector firing in-container then navigating:
`✓ auth profile applied: 1 origin(s), 1 localStorage entr(ies), 0 cookie(s)`.
Reachability: `host.docker.internal:3000` resolves and returns 200 from the agent
image with NO `--add-host` (Docker Desktop macOS auto-provides it).

## Origin reconciliation for host-served apps (#183 — resolved)

The agent must browse `host.docker.internal:3000` (a container can't reach the
host's `localhost` on macOS), but the profile was captured at `localhost:3000`.
The injector guards localStorage by `location.origin`, so the captured origin
must match what the agent browses. The proof initially hand-derived a
`qa-admin-docker` profile; that's now automatic. Both `forge invoke` and the
pipeline use the shared `resolveAuthStateForContainer` helper (src/v2/auth-state.ts),
which calls `reconcileStateForContainer` — localhost-family origins (`localhost`,
`127.0.0.1`, `0.0.0.0`, `::1`) and cookie domains are rewritten to the container
host (`host.docker.internal`, override `FORGE_CONTAINER_HOST`), preserving
scheme+port. Only when a rewrite is needed is a reconciled copy staged at
`<taskDir>/auth-state.json` (mode 600, so the bearer token isn't exposed by the
task dir's 0777 perms) and mounted instead of the original; real-DNS profiles
mount unchanged. The rewritten origin is logged so the caller knows the URL to
navigate the agent to. The Supabase JWT is origin-agnostic, so the same token
authenticates under the rewritten origin.

**Live-proven end-to-end 2026-05-29** (zero manual steps): a plain `localhost`
capture + `forge invoke manual-qa --auth-profile qa-admin` → forge logged the
rewrite, the agent authenticated (`logged_in: true`, steve@bargelt.com, steve-1,
teams), no hand-derived profile. run-183-auto-reconcile-capstone-582003.

## Dependency pin (#181 + #182)

The injector is **not** in forge — it lives in the browser-tools skill forge
mounts into containers. Pinned dependency:
**`github.com/stevebargelt/pi-skills` branch `feat/preload-storage-state`, commit
`cac695b`** (a fork of `badlogic/pi-skills`). That commit carries the generic
`auth-inject.js` (keyed on `BROWSER_TOOLS_STORAGE_STATE`, #182) + the
`browser-nav.js` wiring. Point `FORGE_BROWSER_TOOLS_DIR` at a checkout on that
branch.

Enforcement: `spawn.ts` fails fast when `--auth-profile` is used but the mounted
browser-tools dir lacks `auth-inject.js` — an old/upstream checkout can't
silently no-op auth. The error names the required fork/branch/commit.

## Pipeline wiring (done)

`forge new --auth-profile <name>` stores the profile on the run; `runNext`
injects it via the shared helper into browser-capable PRIMARY roles only
(`engineer`, `frontend-specialist`, `test-engineer`, `manual-qa` —
`roleUsesBrowser`). Non-browsing roles (architect, tech-lead, advisors) don't
carry the credential and don't trip the browser-tools guard; **reds never
receive it** (`runOneRed` passes no profile). The profile name is stripped from
task inputs so it never rides into a prompt. `forge new` validates the profile
at creation (fail fast); per-step resolution also catches mid-run expiry. Invoke
stays unscoped — an explicit `--auth-profile` is honored for any named agent.

## Still pending (optional)

- `browser-content.js` and `--new`-tab cases reuse the same helper; new-tab
  injection re-registers per nav (harmless duplicate init scripts).
- An upstream PR of `feat/preload-storage-state` to `badlogic/pi-skills` (the
  change is generic now) would drop the fork entirely.
- Long-term: forking the whole pi-skills repo pins *all* its skills to this
  branch's snapshot; revisit if other skills need upstream updates.
- Scoping is a role allowlist, not a per-step workflow flag; a `needs_auth: true`
  step field would be more precise if a non-listed role ever needs to browse.
