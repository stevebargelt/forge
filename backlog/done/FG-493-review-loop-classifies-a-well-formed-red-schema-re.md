---
id: FG-493
type: story
status: done
title: "review-loop classifies a well-formed red-schema reviewer result (verdict: fail) as reviewer_failed/invalid — verdict-vocabulary mismatch at the loop boundary blocks closeability"
created: 2026-07-07
closed: 2026-07-08
closed_commit: bf017688af5d4fe277ab802cceb556c74b8a9389
---

## Problem

The review-loop classifies a well-formed red-schema reviewer result carrying `verdict: "fail"` as `reviewer_failed` (invalid or absent result) — a verdict-vocabulary mismatch at the loop boundary. A real fail verdict with substantiated findings is reported as a STRUCTURAL failure, which blocks closeability and misleads the operator (reviewer_failed reads as infra, not as a genuine failing review).

Observed 2026-07-07, run-review-loop-fg-489-072ea8 (ticket FG-489, route implementation_quick).

## Goal

A reviewer result that is well-formed under the red schema and carries `verdict: "fail"` with findings is consumed as a real review outcome (a needs_fix round with fixer dispatch), while genuinely absent/unparseable reviewer results still stop as reviewer_failed. Loop stop reasons stay trustworthy.

## Evidence

- Reviewer task task-red-wide-8b0a42: status complete, result.json 5793 bytes, well-formed: keys {confidence, findings, invariants_verified, notes, status, verdict}, verdict: "fail", 2 substantiated findings (both docs-drift, both real).
- Loop report (~/.forge/runs/run-review-loop-fg-489-072ea8/review-loop.md): round 1 'reviewer: failed (invalid or absent result)', stop reason reviewer_failed, closeable: no.
- Contrast: the FG-485 loop consumed a red-wide result with verdict needs_fix, and FG-488's with pass — both parsed fine the same day.

## Hypothesis (verify, don't assume)

The loop's reviewer contract accepts a loop-specific verdict vocabulary (pass / needs_fix / …) and treats the standard red vocabulary value 'fail' as invalid, so a reviewer that phrases its verdict as a red (its native schema) produces a false STRUCTURAL failure instead of a needs_fix round. Locate the parse in src/v2/review-loop.ts and either (a) accept/map the red vocabulary (fail->needs_fix), or (b) constrain the reviewer prompt so the vocabulary can't drift — plus a regression test for a verdict:'fail' reviewer result.

## Why filed

Blocks review-loop closeability (explicit backlog threshold); false structural failures erode trust in the loop's stop reasons (an operator reading reviewer_failed assumes infra, not a real fail verdict with findings).

## Acceptance criteria

- [ ] A well-formed reviewer result carrying verdict 'fail' with findings produces a needs_fix round (fixer dispatch), not reviewer_failed.
- [ ] A genuinely absent/unparseable reviewer result still stops reviewer_failed (negative half preserved).
- [ ] Regression test through the real loop round-execution path with a stubbed reviewer returning the red-schema shape above.
