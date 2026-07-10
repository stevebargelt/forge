---
id: FG-512
type: story
status: active
title: "runner-side dispatch provenance: stamp dispatchSource on workflow-step rows so taskDispatchKind rule (d) can be deleted"
created: 2026-07-10
---

Follow-up discovered during FG-507 (2026-07-10, review-loop run-review-loop-fg-507-17d35d round 2 + engineer resolution). FG-507 stamps taskPackage.dispatchSource: "invoke" on invoke-created rows, which decisively classifies ad-hoc tasks. The residual corner: a MARKER-LESS row with phase "task" on a workflow that legitimately owns a step id "task" is indistinguishable (legacy invoke --run row vs genuine runner-created step row), so taskDispatchKind rule (d) returns unknown/legacy_ambiguous_phase and forge retry refuses pre-write with an honest message. Consequence: a genuine workflow step literally named "task" cannot be retried. No shipped workflow under seeds/workflows/ declares a step id "task" (grep-verified 2026-07-10), so nothing is currently affected.

Proper close: stamp dispatchSource: "workflow" at the runner-side insertTask sites (runNext.ts ~7 sites, plus gate.ts on_reject / request-changes replacement rows), then delete rule (d) — every post-migration row is decisively classified by recorded provenance and the ambiguity refusal only ever fires for pre-provenance legacy rows.

Acceptance:
- [ ] every runner-created task row carries dispatchSource: "workflow" (all insertTask sites incl. fanout children, reds, on_reject/request-changes rows)
- [ ] taskDispatchKind classifies marker-carrying workflow rows decisively; the legacy_ambiguous_phase refusal fires ONLY for marker-less rows
- [ ] a genuine workflow step with id "task" (fixture workflow) is retryable end to end
- [ ] regression: invoke-marker rows unaffected; legacy marker-less non-"task" phases still classify structurally