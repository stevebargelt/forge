---
id: FG-485
type: story
status: active
title: campaign resume cannot continue a full_feature item parked at a human gate — a manually-gated run is classified manually-driven/out-of-band and re-parked on ship-evidence instead of re-driven (FG-475 sibling)
created: 2026-07-07
---

Observed live 2026-07-07, campaign-6cc65ccc6519 (sequential, 4x full_feature), item FG-481, run run-fg-481-a9d3f6.

## Problem

The campaign paused at the feature workflow's architect human gate ("Human gate required at step architect"). The operator decided the gate in-run (forge gate <task> request-changes), which seeded a pending replacement architect task, then ran forge campaign resume. Resume did NOT re-drive the workflow (the pending replacement was never dispatched); it classified the item as awaiting_gate-on-a-manually-driven-run, evaluated OUT-OF-BAND SHIP ELIGIBILITY, refused (missing: ticket_status_not_done, ticket_closed_commit_missing, closed_commit_not_reachable_on_base_branch, lane_evidence_missing — correct refusal, no evidence exists yet), and re-parked. Log: notes/campaign-6cc65ccc6519.log.

Consequence: every human-gated full_feature campaign item requires the operator to hand-drive the ENTIRE remaining workflow (forge next ...) outside the campaign, close the ticket, then forge campaign reconcile to derive shipped — the campaign can only ledger the item, not execute it. This is the dispatch-side sibling of FG-475's resume wedge (that one is fixed — resume now re-parks cooperatively instead of wedging/spinning) and a concrete instance of the F2/FG-477 item-state-vs-run-state projection mismatch.

## Goal

forge campaign resume on an item whose run is active with dispatchable work (e.g. a pending gate-replacement primary after request-changes) re-enters the workflow drive loop for that run — gate decisions made in-run by the operator do not eject the item from campaign-driven execution. Out-of-band ship-evidence evaluation remains the fallback for runs that are genuinely terminal/externally completed, not the first response to a live run.

## Acceptance criteria

- [ ] Reproduce shape: campaign full_feature item parks at a human gate; operator gates request-changes (replacement pending); campaign resume dispatches the replacement and continues driving the run.
- [ ] Same for advance: operator advances the gate; resume drives the next phase instead of re-parking on ship-evidence.
- [ ] Out-of-band eligibility evaluation still applies to items whose runs are terminal or externally closed (existing reattach tests stay green).
- [ ] Regression test through the real resume path for the re-park loop above (the refusal itself was correct; the missing piece is drive, not evidence policy).
