---
id: FG-517
type: story
status: deferred
title: "notify: campaign-scoped milestone channel — a zero-runs campaign pause (anyHeld with no runs anywhere) cannot push via run-scoped emitMilestone"
created: 2026-07-10
---

Split out of FG-516 (2026-07-10): the one unattended-park corner that CANNOT notify with the existing run-scoped notify machinery.

FG-516 wired every executor running→paused park to emitMilestone. Parks whose item has no run of its own scope to a campaign fallback run (pickCampaignFallbackRunId — the first item whose runId resolves). The residual: a campaign where EVERY item was held before ANY run ever existed has no run anywhere to anchor a run-scoped milestone — emitMilestone hard-requires a real run (getRun throw; runElapsedMs from run.createdAt; dedupe via eventsForRun). That final anyHeld pause stays silent today; the executor comment marks the residual and cites this ticket.

Two review-loop rounds (run-review-loop-fg-516-f5041d) flagged the silence as an AC violation; it was deferred here rather than absorbed because building a campaign-scoped emission path is new notify-machinery scope, which FG-516's own scope guard (wire existing machinery only) forbade — the two AC lines conflict in exactly this corner.

Implementation notes for whoever picks this up:
- events.run_id is ALREADY nullable TEXT with no FK (src/store/schema.ts:72), so recording a campaign-scoped orchestrator.milestone event needs no schema change — the work is in emitMilestone (accept a campaign scope: skip the run lookup, elapsed from campaign.createdAt, dedupe over campaign-scoped events instead of eventsForRun) plus a store accessor for events-by-campaign payload scope.
- Keep the FG-516 dedupe-key shape (campaign-pause:<campaignId>:<ticketId>) so a later run-scoped re-park of the same item still dedupes against the campaign-scoped first push if practical.
- Reachability check worth doing first: enumerate how an item can be held with no run ever created; if the corner is provably unreachable in shipped workflows, say so in this ticket and downgrade it to documentation.

Acceptance:
- [ ] a campaign pausing via the anyHeld final park with ZERO runs across all items pushes exactly one deduped notification per held item (or one campaign-level notification — design call, justify), carrying campaign id + ticket + requestedHumanAction
- [ ] no schema change without an ADR; if one proves necessary, stop and surface it
- [ ] regression test through the real executor path for the zero-runs campaign park

## Disposition — 2026-07-19

Deferred pending evidence that a zero-run `anyHeld` campaign pause is reachable in shipped workflows or has caused a live operator-visible incident. Do not build new campaign-scoped notification machinery solely for the hypothetical corner.
