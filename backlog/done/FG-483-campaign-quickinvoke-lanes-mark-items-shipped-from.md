---
id: FG-483
type: story
status: done
title: campaign quick/invoke lanes mark items shipped from hand-editable ticket frontmatter, bypassing the host-verification/evidence gate every other ship path enforces (review F4)
created: 2026-07-07
closed: 2026-07-07
closed_commit: cb748c8
---

Source: independent engineering review 2026-07-06 (notes/forge-engineering-review-2026-07-06.md, finding F4 — HIGH). Review of main @ fbb070c.

## Problem

src/campaign/executor.ts:1204-1216 (quick_implementation) and :1303-1314 (docs/test/review/research lanes): outcome = "shipped" iff freshTicket.status === "done" && !!freshTicket.closedCommit, then lifecycleStatus complete. !!closedCommit is a non-empty-string test — no commit-existence, no reachability, no host_verifications row. Compare: the pipeline terminal path requires evaluateAuthoritativeOutcome === "pass" AND done-audit pass (executor.ts:398-433); the resume/reattach path for the identical parked shape requires composeOutOfBandEligibility (host verification for code-touching commits, executor.ts:711-727). closeTicket (backlog/structured.ts:239-250) accepts any --commit string unvalidated. The quick chain has no red step, and agents are known to self-commit and can write backlog/.

An engineer agent that closes its own ticket (or any pre-closed ticket) makes the campaign record "shipped" with zero host-side proof the merged tree compiles — the exact frontmatter-trust the reconcile/evidence layer was built to reject (reconcile-evidence.ts:8-12).

## Fix direction (from the review)

Route drive-time invoke-lane finalize through the same eligibility the resume path uses (collectReconcileEvidence / collectOutOfBandEvidence -> composeOutOfBandEligibility); minimally require checkClosedCommitReachableOnBase + a covering passing host-verification row for code-touching commits (non-code lanes use the existing out-of-band non-code evidence model), else park at awaiting_gate (the parked path already exists and is hardened).

## Acceptance criteria

- [ ] Drive-time quick/invoke-lane finalize derives shipped from the same evidence eligibility the resume/reattach path uses — never from ticket frontmatter alone.
- [ ] Negative test (the review's spoof shape): quick-lane item whose ticket is done with a fabricated/uncovered closedCommit — assert NOT shipped (parks awaiting_gate or equivalent held state). Today it ships; that must fail closed.
- [ ] Code-touching commits require commit reachability on base + a covering passing host-verification row; non-code lanes (docs/test/review/research) use the existing out-of-band non-code evidence classification.
- [ ] Operational behavior change documented operator-facing (docs/concepts.md campaign section): post-fix, ALL invoke lanes (quick_implementation AND docs/test/review/research) park at awaiting_gate until their worktree branch is merged to base and `forge campaign reconcile` derives shipped — drive-time finalize EVALUATES existing evidence only, never executes host commands or auto-merges (architect openQuestions answered: park-don't-capture is intended; no auto-merge exists or is added here).
- [ ] A legitimately-shipped quick item (real merged commit + passing host verification) still ships — positive path covered.
- [ ] Drive-time and resume-time eligibility share ONE implementation (no second drift-prone copy).
