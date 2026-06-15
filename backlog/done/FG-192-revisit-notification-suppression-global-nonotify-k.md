---
id: FG-192
type: story
status: done
title: "Revisit notification suppression: global NO_NOTIFY kill-switch + invoke-path noise"
---

**Closed:** 2026-05-29.

Revisit how forge suppresses notifications. Two related problems in the notify subsystem, to be solved together.

**Problem 1 — testing suppression is indirect.** Today #175 silences the test suite by clearing FORGE_NOTIFY in src/test-setup.ts so isAnyProviderEnabled() is false. That works but it is implicit (you have to know that clearing the provider list is what disables notifications) and only covers the in-process suite. Proposed: a single explicit global kill-switch, e.g. NO_NOTIFY=true, checked at the top of the dispatch path (src/notify/trigger.ts dispatch() / isAnyProviderEnabled()) that short-circuits ALL providers regardless of FORGE_NOTIFY / NTFY_URL / Twilio config. Then test-setup.ts (and any other "don't notify" context) just sets NO_NOTIFY=true — clearer intent, one lever, provider-agnostic.

**Problem 2 — orchestrator-internal invoke runs notify on every completion.** Every `forge invoke` is its own run; updateRunStatus (src/store/runs.ts:128) fires notifyOnRunTransition on complete/failed, and the default FORGE_NOTIFY_ON includes complete+failed. So an orchestrator-driven invoke chain (engineer -> test-engineer -> ...) buzzes the human once per sub-agent, even though the orchestrator is watching synchronously and the human only needs gate / blocked / awaiting / top-level-pipeline-complete signals. Hit live 2026-05-29 during the #186 work (4+ pushes for one logical task). Candidate fix: suppress complete/failed ntfy for invoke-path runs specifically (keep them for `forge new` pipeline runs and ALL gate/blocked/awaiting states everywhere), or a per-invoke quiet flag. Role/path-based suppression is cleaner since the orchestrator always wants invokes quiet.

**Why together:** both are "this transition is not a human-actionable signal" — the same insight #175 applied to the test path. A clean design might unify them: a notification-policy layer where NO_NOTIFY is the hard global off, FORGE_NOTIFY_ON is the transition filter, and invoke-path runs default to a quiet policy.

Relates to #175 (test suite no longer notifies — the narrow precedent). Deferred — not urgent.