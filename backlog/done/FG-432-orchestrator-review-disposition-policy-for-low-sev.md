---
id: FG-432
type: story
status: done
title: Orchestrator review-disposition policy for low-severity findings
created: 2026-07-02
closed: 2026-07-05
closed_commit: e5f8e65
---

## Problem

The orchestrator asks the operator how to handle low-severity reviewer findings even when policy should decide. This creates friction and makes the operator arbitrate routine engineering disposition instead of having the orchestrator apply severity, blast radius, and trust-boundary policy.

Observed during FG-428: red-wide returned PASS with three low findings. Two findings were fail-safe follow-up candidates, while one was cheap trust-gate write-path hardening. A human advisor could classify this as "fix the trust-gate invariant now, defer the fail-safe lows," but the orchestrator asked the operator to decide.

## Goal

Teach the orchestrator to classify reviewer findings by ship-risk and trust-boundary impact, then make a recommendation/decision without asking unless product intent or risk tolerance is genuinely ambiguous.

## Acceptance Criteria

- Orchestrator guidance says wrong-ship, data-loss, security, trust-bypass, or trust-gate evidence-bypass findings block close.
- Fail-safe low findings that only cause over-refusal, cosmetic labels, imprecise reporting, or operator friction are follow-up candidates, not blockers.
- Cheap local trust-gate write-path invariant hardening should be fixed before close when low-risk and directly related to the touched path.
- The orchestrator may still ask the operator when a finding changes product behavior, scope, explicit risk tolerance, or requires a non-local hardening/refactor.
- Include a concrete example matching FG-428: fix campaign_id CAS ownership hardening now; defer inconclusive-supersession refusal-label cleanup and host-verification project_dir canonicalization false-refusal into one follow-up.
- The orchestrator surfaces the decision and rationale, rather than presenting routine review disposition as an operator choice.

## Non-Goals

- Does not weaken review gates or allow closing with wrong-ship-capable findings.
- Does not require gold-plating every low-severity robustness issue before close.

## Relations

- Related to FG-429 (orchestrator should resolve policy-derived decisions instead of asking the operator).
- Surfaced during FG-428 campaign reconciliation recovery review disposition.