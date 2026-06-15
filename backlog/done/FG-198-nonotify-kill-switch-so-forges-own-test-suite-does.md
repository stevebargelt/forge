---
id: FG-198
type: story
status: done
title: NO_NOTIFY kill-switch so forge's own test suite doesn't fire real notifications
---

**Closed:** 2026-06-07.

A single explicit global env kill-switch, e.g. NO_NOTIFY=true, checked at the top of the notify dispatch path (src/notify/trigger.ts isAnyProviderEnabled / dispatch) that short-circuits ALL providers (ntfy + Twilio) regardless of FORGE_NOTIFY / NTFY_URL config.

**The ONLY problem this solves:** when forge runs its OWN test suite, tests transition runs to complete/failed -> updateRunStatus -> notifyOnRunTransition -> real push. #175 already fixed this narrowly by CLEARING FORGE_NOTIFY in src/test-setup.ts, but that's implicit (you have to know clearing the provider list disables notifications) and provider-specific. NO_NOTIFY=true is an explicit, provider-agnostic 'this context is not real work, stay silent' lever. test-setup.ts then just sets NO_NOTIFY=true.

**Explicitly NOT in scope — do not suppress real run notifications.** Real forge invoke / forge new runs completing are exactly what notifications are FOR: the human is away and the ping is their signal that agent work finished. An earlier version of this ticket (closed #192) wrongly framed orchestrator-internal invoke completions as 'noise' to suppress — that was a mistaken read. Per-run completion notifications for legit runs are the feature working correctly. This ticket is ONLY about silencing forge's automated test suite (and any other explicitly-flagged non-production context), never real work.

Relates to #175 (the narrow test-setup.ts precedent this generalizes).

**Shipped (commit 90e9a81):** `isNotifySuppressed()` (NO_NOTIFY=true|1|yes) guards both chokepoints — `isAnyProviderEnabled()` (every transition/gate/red/milestone path) and `dispatch()` — provider-agnostic, ignores FORGE_NOTIFY/NTFY_URL/TWILIO_*. test-setup.ts sets NO_NOTIFY=true suite-wide (FORGE_NOTIFY="" kept as defense-in-depth). Real runs untouched (unset/empty/false/0 never suppress). 5 focused tests; full suite green. Reviewed via `forge review-loop 198 --review-profile codex-subscription` — Codex (provider openai, gpt-5.5) returned pass round 1, verification green.