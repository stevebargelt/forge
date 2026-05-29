# Auth profiles: CDP localStorage injection is the load-bearing mechanism (#176 spike)

**Date:** 2026-05-28
**Status:** spike complete — mechanism proven, build pending
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

## Build split (next)

- **forge (this repo):** `auth_profiles` resolution (host-global `~/.forge/auth/`
  + project override), `forge auth-profile {login,status,list,rm}`, `--auth-profile`
  on invoke/pipeline, spawn.ts copies state into the authed task container tmp (never
  via project mount), redact path+contents from prompts/logs, expiry parse for status.
- **pi-skills/browser-tools (external):** the CDP injector above, run before the
  agent's first navigation.

## Note

The spike left a **live** session token at `~/.forge/auth/spike-wnba.storage.json`
(mode 600, host-global, gitignored territory) plus screenshots with the user's
email. Bearer credential — delete when done spiking.
