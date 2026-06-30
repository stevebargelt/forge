---
id: FG-421
type: story
status: done
title: Shipping Reviewer must verify operator-decision contracts end-to-end
epic: FG-372
created: 2026-06-30
closed: 2026-06-30
closed_commit: 2f0ff4b
---

## Problem

FG-420 promoted the Shipping Reviewer to authoritative, but it missed an operator-contract gap: the design said a force rationale is the human-decision record, while the actual gate path allowed `--force` without a rationale.

This is the same production-path consistency class that has appeared repeatedly: local feature behavior works, but the operator surface, lifecycle command, or persisted evidence path still violates the acceptance contract.

## Goal

Strengthen the Shipping Reviewer seed/rubric so it explicitly checks whether claimed human/operator decisions are enforced in the real command/API path and leave durable evidence.

## Acceptance Criteria

- Shipping Reviewer instructions include an explicit operator-contract check:
  - if a design says an override, approval, rationale, audit note, or human decision is required, verify the command/API path enforces it;
  - verify the record is persisted, not only mentioned in docs, notes, or console output;
  - verify tests cover both missing-record rejection and valid-record success.
- Shipping Reviewer guidance tells the reviewer to inspect relevant command/API paths when a ticket makes operator-contract claims, including paths such as `gate`, `campaign approve`, `record-host-verification`, dashboard APIs, or campaign controls.
- Add a seed guard, golden fixture, or equivalent test for the FG-420 failure shape: when a ticket says "`--force --rationale` is the human-decision record", the reviewer must check whether `--force` without rationale is rejected.
- The guidance must emphasize production-path tracing, not mapper-only, seed-only, or docs-only validation.
- Do not change FG-420 gate behavior in this ticket; this ticket improves Shipping Reviewer review quality.

## Non-Goals

- Do not change `gate.ts` behavior here.
- Do not change Shipping Reviewer verdict vocabulary or red-ingestion semantics.
- Do not add a new task status or human-gate state.
- Do not require the Shipping Reviewer to inspect every CLI command on every run; scope the check to tickets that make operator-contract or persisted-decision claims.

## Relations

- Related to FG-420: authoritative Shipping Reviewer promotion and force-override human-decision record.
- Related to FG-417: production-path consistency tracing.
- Related to FG-384: Shipping Reviewer role and verdict mapping.
- Child of FG-372.
