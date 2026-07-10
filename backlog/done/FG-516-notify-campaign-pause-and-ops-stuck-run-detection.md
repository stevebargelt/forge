---
id: FG-516
type: story
status: done
title: "notify: campaign pause and ops stuck-run detection must push — unattended wedges currently fire nothing"
created: 2026-07-10
closed: 2026-07-10
closed_commit: b1490bd
---

Review finding F9 residual (queued 2026-07-10, item 2 of 4 in the sequential reliability queue) — the last silent unattended-failure class.

Today the only milestone pushes fire on run-terminal, blocked_by_red, and awaiting_gate. Verified by survey:
- src/campaign/executor.ts contains ZERO notify calls while holding ~10 tryTransitionCampaign(campaignId, "running", "paused") park sites (lines ~321, 340, 364, 529, 578, 640, 677, 722, 733, 746) — every drive-error park, no-progress park, blocker park, and recovery park happens silently. An overnight campaign that wedges tells nobody.
- src/ops/* detects incidents (orphaned work, stuck runs) without notifying; forge ops check surfaces them only when an operator manually runs it.

The notify machinery already exists: emitMilestone (src/notify/milestone.ts) with kinds, dedupe keys (suppression of a repeat push for the same key within a run), consent/policy/throttle handling.

**Scope resolution (2026-07-10, recorded after review-loop run-review-loop-fg-516-f5041d):** AC1 and AC4 conflict in exactly one corner. A campaign whose EVERY item was held before ANY run existed has no run anywhere to anchor a run-scoped milestone — emitMilestone hard-requires a real run, and building a campaign-scoped emission path is new notify-machinery scope that AC4 (wire existing machinery only) forbids. Per the queue's global rule (genuinely-new scope gets filed, never absorbed), that zero-runs corner is deferred to **FG-517** (campaign-scoped milestone channel), and AC1 below is scoped accordingly: every park site notifies, with parks whose item lacks a run scoping to a campaign fallback run (first item whose runId resolves); only the zero-runs-anywhere campaign remains silent, marked at the site with a comment citing FG-517. All other park sites, including the anyHeld final park on any campaign that ever created at least one run, push normally.

**Review disposition (2026-07-10, after review-loop run-review-loop-fg-516-ea61aa):** the resume-probe workflow-load-failure park finding (executor.ts:~1099 — milestone fires but carries the item's stale gate action instead of the load-failure reason) is dispositioned FAIL-SAFE-DEFERRED to **FG-518** per the review-disposition policy: the notification fires (no silent wedge — the ticket's core invariant holds on this path), campaign+ticket ride the provider title, and the defect is message-precision friction only — no wrong-ship/data-loss/trust surface. FG-518 carries the context fix + a real-resume-path regression. This park shape is NOT part of this ticket's AC evidence walk; the deferral is the resolution.

**Operator scope amendment + structural direction (2026-07-10, after review-loop run-review-loop-fg-516-bb0e8f):** two round-2 findings are ACCEPTANCE VIOLATIONS, not disposition-away polish: (a) dedupe was run-scoped (milestone.ts) so a `campaign retry` (which clears runId) followed by a re-park on a new run re-pushed the same campaign+item — violating AC1's "deduped per campaign+item so re-parks do not spam"; (b) several park paths notified without proving their running→paused CAS committed — violating the manual-pause exemption (a concurrent operator pause winning the CAS still produced an "unattended wedge" push). The fix is structural: ONE parkCampaign boundary in executor.ts owns the CAS and notifies only on commit (a source-scan guard test makes bypassing it unrepresentable), and emitMilestone gains an explicit dedupe scope so campaign-pause keys dedupe GLOBALLY across runs. The original AC4 scope guard is AMENDED by the operator to authorize that notify-machinery dedupe-scope change (still no new channels/kinds/config/schema). FG-517 remains only the zero-runs EMISSION channel; FG-518 remains the resume-probe message-precision deferral.

Acceptance:
- [ ] every UNATTENDED campaign park — each executor.ts running→paused park — fires a milestone notification carrying ticket, blockerKind, and requestedHumanAction, THROUGH the single parkCampaign boundary: the notification fires ONLY when the park's CAS committed (a concurrent operator pause winning the CAS produces no push), and dedupe is campaign+item DURABLE ACROSS RUNS (a retry that clears runId then re-parks on a new run does not re-push). A structural guard test forbids any transition/notify pairing outside the boundary. Items without a run of their own scope to a campaign fallback run. (Two documented exemptions: the operator-initiated `forge campaign pause` CLI path — the human's own action, not an unattended wedge; and the zero-runs-anywhere campaign corner — deferred to FG-517 per the scope resolution above, comment at the site.)
- [ ] live-mode forge ops check emits one notification per NEW incident, deduped on incident identity so a re-run over the same standing incidents never re-pushes; a pure read-only/--json invocation must not gain new side effects beyond the dedupe-recorded notification behavior defined here
- [ ] tests drive the REAL triggers (executor park paths, ops check over synthetic incidents) with dedupe negative cases (same park/incident twice → one push), and NO_NOTIFY is respected so the forge test suite stays silent
- [ ] scope guard (as amended by the operator, see above): no new delivery channels, milestone kinds, config surfaces, or schema; the one authorized machinery change is emitMilestone's explicit dedupe scope (global-across-runs for campaign-pause keys)
