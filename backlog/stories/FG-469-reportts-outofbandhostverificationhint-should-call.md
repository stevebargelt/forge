---
id: FG-469
type: story
status: active
title: "report.ts: outOfBandHostVerificationHint should call describeMissingReason('lane_evidence_missing') instead of hardcoding the same string (single source of truth)"
created: 2026-07-05
---

## Problem
`describeMissingReason` (reconcile-evidence.ts) is documented (header, lines 77-82) as the SINGLE shared source of the human-facing missing-reason text used by campaign.ts and report.ts. But report.ts's `outOfBandHostVerificationHint` hardcodes its own copy of the `lane_evidence_missing` sentence rather than calling `describeMissingReason('lane_evidence_missing')`. Both strings match today, but they are now two independent sources of truth — a future edit to one won't propagate.

## Severity
Low / maintainability. Pre-existing (FG-452), surfaced by FG-465's review-loop as a non-blocking pass-note. No behavior bug today.

## Direction
Replace the hardcoded string in `outOfBandHostVerificationHint` with a call to `describeMissingReason('lane_evidence_missing')` (verify the surrounding wording — report.ts adds a `run forge campaign reconcile ... re-check` tail that describeMissingReason now also carries). Keep the existing runId/hasUnresolvedAuthoritativeOutcome short-circuit.

## Reference
src/campaign/report.ts:177 outOfBandHostVerificationHint; src/campaign/reconcile-evidence.ts describeMissingReason. FG-465, FG-452.