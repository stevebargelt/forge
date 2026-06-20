---
id: FG-172
type: story
status: done
title: Gate request-changes should apply the rationale's fix list in place, not re-run the phase/plan
closed: 2026-06-20
---

**Caught 2026-05-28** on wnba-led-scoreboard (same review as the discipline-fanout gap, #171): when the human used request-changes at a build gate, it drove a re-run rather than a targeted application of the rationale's fix list.

**Current behavior (`gate.ts`).** request-changes marks the task failed and inserts a pending task in the SAME step, carrying the rationale as `inputs.requestedChanges`. So the implementer re-runs the whole step with the rationale as free text, rather than surgically applying the specific fixes the human listed against the existing diff. (Reject + `on_reject` is the other path — that loops to an upstream step, e.g. brief/plan, = a full re-plan.)

**Desired.** request-changes should feed the rationale's fix list to the implementer as a targeted change set: "apply these specific fixes to your existing diff," preserving work already done, not regenerating the step from scratch or re-planning upstream.

**Open question for whoever picks this up.** Pin down which path the wnba run actually hit — request-changes re-running the full build step, or a reject→on_reject upstream re-plan. The fix differs:
1. make the request-changes re-dispatch incremental (carry the prior diff + fix list, instruct surgical edits), vs
2. ensure UI-variant build gates expose request-changes (in-place) rather than only reject (upstream).

Same class of forge rough-edge as the browser/:9222 and forge-test/Jest gaps surfaced 2026-05-28.