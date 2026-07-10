---
id: FG-516
type: story
status: active
title: "notify: campaign pause and ops stuck-run detection must push — unattended wedges currently fire nothing"
created: 2026-07-10
---

Review finding F9 residual (queued 2026-07-10, item 2 of 4 in the sequential reliability queue) — the last silent unattended-failure class.

Today the only milestone pushes fire on run-terminal, blocked_by_red, and awaiting_gate. Verified by survey:
- src/campaign/executor.ts contains ZERO notify calls while holding ~10 tryTransitionCampaign(campaignId, "running", "paused") park sites (lines ~321, 340, 364, 529, 578, 640, 677, 722, 733, 746) — every drive-error park, no-progress park, blocker park, and recovery park happens silently. An overnight campaign that wedges tells nobody.
- src/ops/* detects incidents (orphaned work, stuck runs) without notifying; forge ops check surfaces them only when an operator manually runs it.

The notify machinery already exists: emitMilestone (src/notify/milestone.ts) with kinds, dedupe keys (suppression of a repeat push for the same key within a run), consent/policy/throttle handling.

Acceptance:
- [ ] every UNATTENDED campaign park — each executor.ts tryTransitionCampaign(running→paused) site — fires a milestone notification carrying ticket, blockerKind, and requestedHumanAction, deduped per campaign+item so re-parks of the same item do not spam. (The operator-initiated `forge campaign pause` CLI path is exempt: it is the human's own action, not an unattended wedge — document the exemption at the site.)
- [ ] live-mode forge ops check emits one notification per NEW incident, deduped on incident identity so a re-run over the same standing incidents never re-pushes; a pure read-only/--json invocation must not gain new side effects beyond the dedupe-recorded notification behavior defined here
- [ ] tests drive the REAL triggers (executor park paths, ops check over synthetic incidents) with dedupe negative cases (same park/incident twice → one push), and NO_NOTIFY is respected so the forge test suite stays silent
- [ ] scope guard: wire the EXISTING notify machinery only — no new delivery channels, no config surface changes
