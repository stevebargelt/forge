---
id: FG-426
type: story
status: done
title: "Campaign policy: classify integration_failed as a scoped item blocker, not the campaign_system default"
created: 2026-07-01
closed: 2026-07-06
closed_commit: 44aea95
---

## Problem

`classifyFailureKind` in `src/campaign/policy.ts` has no explicit case for the `integration_failed` failure kind introduced by FG-357. When a campaign item's feature workflow ends in `integration_failed` (post-merge integration gate caught a broken merged tree), the classifier falls through to the conservative `campaign_system` default. That default treats the outcome as a system-level blocker and defensively HOLDS all subsequent items, rather than recognizing it as a scoped, item-level implementation failure the operator can act on. Observed during the FG-357 delivery campaign (campaign-922c83b7c577): the integration gate's own new outcome is not a first-class campaign blocker classification.

## Goal

Give the campaign policy a first-class classification for `integration_failed` so campaign outcome/hold behavior matches the real meaning of the outcome (a scoped merged-tree build/test failure), instead of the conservative system-default catch-all.

## Acceptance Criteria

- `classifyFailureKind` has an explicit case for `integration_failed`, mapping it to the appropriate scoped blocker kind (item-scoped, operator-actionable) rather than `campaign_system`.
- The chosen classification and its hold/continue implications are documented alongside the other campaign blocker kinds.
- A test asserts an `integration_failed` item outcome classifies to the intended scoped kind and drives the intended hold/continue policy (not the conservative system default).
- No regression to the classification of existing failure kinds (`merge_conflict`, `gate_rejected`, etc.).

## Relations

- Follow-up to FG-357 (post-merge integration gate) and its new `integration_failed` kind. Surfaced by the documentation-maintainer during the FG-357 docs phase.
- Related to FG-370 (Campaign Runner) blocker classification and hold semantics.
