---
id: FG-175
type: story
status: done
title: Test suite fires real ntfy/twilio notifications — test-setup.ts didn't neutralize providers
---

**Closed:** 2026-05-29.

**Symptom:** running `npm test` in a shell with `FORGE_NOTIFY=ntfy` + `NTFY_URL` set sprays real push notifications — one per test run that transitions to complete/failed. Hit 2026-05-29: ~20 `[complete]` pushes for synthetic fixtures (`run-invoke-engineer-… some-project/x … — 0s`) during repeated suite runs.

**Cause:** `updateRunStatus` (src/store/runs.ts) fires `notifyOnRunTransition` on every terminal transition; both providers gate only on `FORGE_NOTIFY` (notify/ntfy.ts, notify/twilio.ts). `src/test-setup.ts` isolated the test DB (#170) but left notification env untouched, so fixtures fired real pushes to whoever's env was set in the shell.

**Fix (shipped):** `src/test-setup.ts` now sets `process.env.FORGE_NOTIFY = ""` for the whole suite → `isAnyProviderEnabled()` false → no pushes. Verified: full suite green, zero notifications.

**Lesson:** test isolation must cover *side-effects*, not just the DB — anything keyed off process env (notify, future webhooks) needs neutralizing in test-setup. Same class as #170.