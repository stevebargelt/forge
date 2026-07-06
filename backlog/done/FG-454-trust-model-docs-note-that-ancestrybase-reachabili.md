---
id: FG-454
type: story
status: done
title: "Trust model docs: note that ancestry+base-reachability coverage widens a single manual record-host-verification row's effective scope within a ticket (FG-452 red-wide finding 3)"
created: 2026-07-03
closed: 2026-07-06
closed_commit: c7335de
---

## Problem
The host-verification evidence matching rule (docs/concepts.md, Reconcile / done-audit sections) matches a recorded row to a ticket's `closedCommit` by COVERAGE, not exact sha: `closedCommit` must be a git ancestor of the row's tested commit, and that tested commit must be reachable on the configured base branch. A consequence not spelled out for operators: a SINGLE manual `forge record-host-verification` row therefore has a WIDER effective trust scope than the one sha it names — it vouches for every `closedCommit` that is an ancestor of the recorded commit (within the ticket's identity: same ticketId + projectDir + gateName). An operator recording one host-verification row may not realize it can satisfy the gate for other (earlier, ancestor) commits attributed to that ticket. (FG-452 red-wide finding 3.)

## Goal
Make the trust-model docs explicit that ancestry + base-reachability coverage widens a single manual host-verification row's effective scope within a ticket, so an operator recording evidence understands the scope of what one row attests.

## Acceptance Criteria
- The trust-model / host-verification docs (docs/concepts.md host-verification matching section, and any operator-facing note on `forge record-host-verification`) explicitly state that one recorded row covers every `closedCommit` that is an ancestor of the row's tested commit (same ticketId + projectDir + gateName), i.e. its effective scope is a commit range, not a single sha.
- The note frames this as intentional (the gate runs at HEAD, never a checkout of closedCommit, so exact-sha matching would never find a real capture) AND as a caveat the operator should understand when recording evidence manually.
- Consistent with the existing coverage-matching prose; no code change; does not weaken or alter the matching rule.

## Non-Goals
- No code change; does not alter the matching/coverage rule — documentation only.

## Reference
docs/concepts.md host-verification matching (the coverage rule: ancestor of tested commit + base-reachability). FG-452 red-wide finding 3. Related: FG-419 (record-host-verification), FG-440/FG-453 passing-row aggregation.
