---
id: FG-485
type: story
status: active
title: "campaign resume evaluated ship-evidence before run liveness — false refusal event/message on a live human-gated run (fix: liveness-first reattach; FG-475 sibling)"
created: 2026-07-07
---

Observed live 2026-07-07, campaign-6cc65ccc6519 (sequential, 4x full_feature), item FG-481, run run-fg-481-a9d3f6.

## RESOLUTION NOTE (2026-07-07, evidence-based reframe at closeout)

The original claim below — "Resume did NOT re-drive the workflow (the pending replacement was never dispatched)" — was **disproved by the durable event stream** of the evidence run: `campaign_item.evidence_reconcile_refused` at 03:44:37.756Z was followed 17ms later by `task.started task-architect-e2f1e9` (03:44:37.773Z), inside the same resume invocation, ~2 minutes before the external driver's first `forge next` poll. Resume then stayed attached through the replacement's container, reds, and the next gate park. Confirmed prospectively twice more on current main (run-fg-485-7bfcb2, this ticket's own pipeline). The misleading part was the ORDER of evaluation: evidence-first on a live run emitted a false refusal event and the "refusing to ship and re-parking" message immediately before driving — which is what misled the operator into filing the stronger claim.

**What shipped (PR #60, merge dc7d725):** liveness-first reattach — resume probes the run (pipeline runs only, via taskHasPipelineFinalize; computeReadyQueue for dispatchable work) BEFORE any evidence evaluation and re-enters the drive loop directly; the evidence fallback and its refusal event/message now fire only for runs that are absent, inactive, or settled with nothing to drive; a pipeline run whose workflow fails to load returns recovery_needed (never the evidence path); invoke-family runs keep the FG-483 evidence path unchanged; run/workflow loaded once and reused. Five regression scenarios through the real resumeCampaign path (request-changes dispatch, advance drives next phase, terminal fallback, load-failure, invoke-family skip).

## Original problem statement (premise corrected above; kept for the record)

The campaign paused at the feature workflow's architect human gate ("Human gate required at step architect"). The operator decided the gate in-run (forge gate <task> request-changes), which seeded a pending replacement architect task, then ran forge campaign resume. Resume evaluated OUT-OF-BAND SHIP ELIGIBILITY first, refused (missing: ticket_status_not_done, ticket_closed_commit_missing, closed_commit_not_reachable_on_base_branch, lane_evidence_missing — correct refusal, no evidence exists yet), printed "refusing to ship and re-parking", and only then drove the run. The false refusal signal (event + message) on a live run was the defect; the dispatch itself already worked.

## Goal (as shipped)

forge campaign resume on an item whose run is active with dispatchable work (e.g. a pending gate-replacement primary after request-changes) re-enters the workflow drive loop for that run without evaluating — or emitting refusal signals about — out-of-band ship evidence. Out-of-band evidence evaluation remains the fallback for runs that are genuinely terminal/externally completed.

## Acceptance criteria

- [x] Reproduce shape: campaign full_feature item parks at a human gate; operator gates request-changes (replacement pending); campaign resume dispatches the replacement and continues driving the run. (Regression test through real resumeCampaign; also observed live 3x.)
- [x] Same for advance: operator advances the gate; resume drives the next phase instead of re-parking on ship-evidence. (Regression test; observed live.)
- [x] Out-of-band eligibility evaluation still applies to items whose runs are terminal or externally closed (existing reattach tests green with zero assertion edits; new terminal-fallback scenario added).
- [x] Regression test through the real resume path for the re-park loop above. (fg485-resume-drives-live-gate.integration.test.ts, 5 scenarios; plus: no evidence_reconcile_refused event fires for a live run.)