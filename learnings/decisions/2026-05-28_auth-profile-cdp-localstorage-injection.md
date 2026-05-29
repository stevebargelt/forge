# Auth profiles: CDP localStorage injection is the load-bearing mechanism (#176 spike)

**Date:** 2026-05-28
**Status:** Slices 1–3 built & verified END-TO-END in a real agent container
**Ticket:** #176 (auth profiles)

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

## Finding from the run: origin reconciliation for host-served apps (→ ticket)

The agent must browse `host.docker.internal:3000` (a container can't reach the
host's `localhost` on macOS), but the profile was captured at `localhost:3000`.
The injector guards localStorage by `location.origin`, so the captured origin
must match what the agent browses. For the proof we hand-derived a
`qa-admin-docker` profile with the origin rewritten to `host.docker.internal`
(the Supabase JWT is origin-agnostic, so the same token authenticates). forge
should reconcile this rather than require a hand-derived profile — see backlog.

## Still pending

- Pipeline steps (`--auth-profile` on browser-verify phases) — invoke covers the
  primary path; pipeline wiring is the same ctx field.
- `browser-content.js` and `--new`-tab cases reuse the same helper; new-tab
  injection re-registers per nav (harmless duplicate init scripts).
- Reproducibility of the browser-tools dep (fork+pin) — backlog #181; env-var
  genericization — backlog #182.

## Note

The spike left a **live** session token at `~/.forge/auth/spike-wnba.storage.json`
(mode 600, host-global, gitignored territory) plus screenshots with the user's
email. Bearer credential — delete when done spiking.
