---
id: FG-472
type: story
status: active
title: forge new feature (non-campaign) has no ticketId → shipping-reviewer pre-fails and BLOCKS the run; decide the intended behavior
created: 2026-07-05
---

## Problem (verified, FG-433 investigation)
The `feature` workflow's verify/build phase includes `shipping-reviewer` as an authoritative red with `gate_on_verdict: true` (seeds/workflows/feature.yml:109). `runNext.ts:665` assembles the reviewer context packet, and if `run.metadata.ticketId` is absent, the shipping-reviewer is PRE-FAILED and `runNext.ts:819` converts that to `authoritativeFail = true` ("block regardless of red configuration").

A campaign-created run carries `run.metadata.ticketId` (FG-464), so it passes. But a plain `forge new feature "title" --brief "..."` sets NO ticketId — `src/cli/commands/new.ts` only builds `inputs` from `--brief`/`--question`/`--prd`/`--meta`; the sole way to attach a ticket is `--meta '{"ticketId":"FG-xxx"}'`. So a default non-campaign feature run is BLOCKED by the shipping-reviewer for want of a ticket.

## Why it meets the filing threshold
Requires a PRODUCT DECISION (block-without-ticket is fail-safe but may be poor operator UX for standalone `forge new feature`), and is user-visible operator pain if standalone feature runs are a real path.

## Decision needed / options
- (a) Add `forge new feature --ticket <id>` that sets `run.metadata.ticketId` (convenience over `--meta`).
- (b) Make the shipping-reviewer CONDITIONAL: skip (with a visible warning) when there is no ticket to review against, instead of an authoritative block. Preserves fail-safe for ticketed runs.
- (c) Keep current behavior (block) and DOCUMENT that the feature workflow requires a ticket association.
Recommendation: (a) or (b). Fail-safe blocking is defensible, but a silent authoritative block at the end of a `--brief` run is surprising.

## Non-goals
- Does not change the campaign path (FG-464/FG-433 — already ticket-aware).

## Reference
seeds/workflows/feature.yml:109; src/v2/runNext.ts:665-820; src/cli/commands/new.ts; src/v2/reviewer-context-packet.ts. Surfaced by FG-433.