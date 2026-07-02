---
id: FG-440
type: story
status: active
title: Campaign items force-advanced/manually-driven get no post-merge host-verification, so evidence-gated reconcile refuses a legitimately-merged+green item
created: 2026-07-02
---

## Problem

`forge campaign reconcile` (FG-428) ships a wedged campaign item only when all durable evidence holds, including a recorded host-verification (host_verifications row for the item's closedCommit, exit 0, matching the required host gate). But nothing automatically records that host-verification for a campaign item whose build was force-advanced over authoritative red-fails and/or was driven to completion + merged manually (outside the campaign resume loop). The post-merge integration gate (FG-357) that would normally produce the host-verification did not run in that path.

Observed with FG-376 (campaign-922c83b7c577): the item was force-advanced past 5 real red findings across several fixer rounds, merged via PR #5 (7211a47), closed with host-verification evidence in the commit message, and the merged result is genuinely green (npm run test:all: root 2584 + dashboard 27, 0 fail). Yet `forge campaign reconcile` refused it with exactly one missing fact: host_verification_missing_or_not_all_exit_zero — because no host_verifications row exists for 7211a47. The orchestrator ran the host gate but there was no automatic capture of that result as durable evidence.

The only current bridge is a manual `forge record-host-verification` call. That works (and is the sanctioned evidence-recording command), but it is easy to forget and leaves a legitimately-shipped item stuck as failed/blocked with no automatic path forward.

## Goal

A campaign item that is legitimately merged and passes the host gate gets its host-verification recorded automatically for the merge commit, so evidence-gated reconcile can ship it without a manual record step — while preserving the anti-spoofing property (the record must reflect a real command+exit, never an assertion).

## Acceptance Criteria

- When a campaign item's result is merged to the base branch, the post-merge host gate (the FG-357 integration gate, or the campaign's own post-merge step) runs against the merged commit and records a host_verifications row (real command + exit code) keyed to that commit.
- After that, `forge campaign reconcile` (or the normal drive) can ship the item on durable evidence without a manual `forge record-host-verification`.
- The force-advanced / manually-driven path is covered: an item whose build was force-advanced still gets post-merge host-verification recorded, so it is reconcilable rather than permanently blocked.
- Anti-spoofing preserved: the recorded verification reflects a genuinely-run command and its real exit code (consistent with record-host-verification's "prove this is a real result, not an assertion" guard). No synthetic exit-0 without a real run.
- Operator-facing: `forge campaign show`/`report` make it clear when an item is blocked solely on a missing host-verification (distinct from a genuine failure), and point to the recovery.

## Refs

- src/campaign/reconcile-evidence.ts / reconcile-collect.ts (host-verification fact), src/cli/commands/record-host-verification.ts, src/store/host-verifications.ts
- FG-357 (post-merge integration gate), FG-428 (evidence-gated reconcile), FG-427 (honor force-advance / later pass over stale red-fail)
- Surfaced recovering FG-376 in campaign-922c83b7c577.
