---
id: FG-439
type: story
status: done
title: "Orchestrator autonomy: decide routine review-gate disposition from policy, not operator preference"
created: 2026-07-02
closed: 2026-07-05
closed_commit: e5f8e65
---

## Problem

Forge repeatedly asks the operator to decide routine review-gate disposition even when the engineering policy is clear from the ticket, review severity, and stated invariants. This preserves "human in the loop" in the wrong place: the operator becomes the reviewer-disposition engine for every medium/low finding, which is not maintainable.

Recent examples:

- FG-428 red-wide lows: the orchestrator asked whether to fix/defer findings even though the policy answer was clear: fix cheap trust-gate write-path hardening now; defer fail-safe cosmetic/false-refusal lows.
- FW-16 review-loop choice: the orchestrator asked whether to run bounded review-loop or rely on human PR review, even though implementation work should default to bounded automated review.
- FG-376 provisioning re-check: the orchestrator asked whether to fix or defer a residual MEDIUM that touched the explicitly stated invariant "no two provisioners can write the same dependency cache volume concurrently, including after crash." That should not be an operator call; the invariant makes it a fix-before-advance decision.

## Goal

Teach the orchestrator to apply review-gate disposition policy autonomously. It should make and execute routine engineering decisions from explicit invariants, severity, blast radius, trust boundaries, and fail-safe/fail-open direction. It should ask the operator only when the decision depends on product intent, scope expansion, explicit risk tolerance, cost/time tradeoff outside established policy, or changing the policy itself.

## Acceptance Criteria

- Orchestrator guidance distinguishes operator decisions from engineering-policy decisions.
- If a finding threatens an explicitly stated non-negotiable invariant, trust boundary, wrong-ship prevention, data integrity, security boundary, or concurrency safety guarantee, the orchestrator classifies it as fix-before-advance without asking the operator, even if the reviewer severity is medium.
- If a finding is fail-safe only (over-refusal, cosmetic label, imprecise message, operator friction) and does not threaten the stated invariant or trust boundary, the orchestrator files or updates a follow-up and proceeds when other gates are green.
- If a finding is broader lifecycle/platform scope than the current ticket but not required to preserve the ticket's core invariant, the orchestrator files a follow-up and explains why it is deferred.
- The orchestrator presents its disposition and rationale, then acts according to policy. It does not present routine fix/defer/advance choices as open-ended operator preference.
- The orchestrator asks the operator only for genuine product/scope/risk-policy calls, such as changing the invariant, accepting a wrong-ship risk, expanding supported platforms, skipping automated review, or trading off a known blocker for an emergency.
- Include examples covering:
  - FG-428: fix cheap trust-gate CAS hardening; defer fail-safe lows.
  - FG-376: fix residual concurrent-provisioner risk because it violates the stated cache-safety invariant; defer AWN-1 provisioning-phase crash reconciler as broader lifecycle follow-up.
  - FW-16: default implementation work to bounded review-loop; do not ask human PR review vs review-loop as a preference.

## Non-Goals

- Does not remove the operator from product direction, scope, prioritization, or policy changes.
- Does not allow auto-advancing over wrong-ship-capable, security, data-loss, trust-boundary, or explicit-invariant findings.
- Does not require gold-plating every low-severity hardening idea before close.

## Relations

- Generalizes FG-432 (low-severity review finding disposition).
- Related to FG-436 (bounded review-loop default and automated merge policy).
- Related to FG-429 (orchestrator should resolve policy-derived decisions instead of asking the operator).