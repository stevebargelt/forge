---
id: FG-416
type: story
status: active
title: "campaign resume: dependency-held items get misleading 'run resume again' message (operator loop)"
created: 2026-06-29
---

## Problem

On `forge campaign resume`, a dependency-held item (FG-393: held because it is `related` to a still-blocked
LOCAL item) is surfaced with the generic message "campaign paused between items — run resume again to
continue". That instruction is wrong — resuming again changes nothing while the upstream blocker is
unresolved, so the operator loops.

Reproduced against the real CLI: paused campaign, FG-901 failed+blocked, FG-902 dependency-held.
`forge campaign resume` → exit 0 with:

```
Stop reason: paused
  FG-902: pending (outcome: held)
campaign paused between items — run resume again to continue
```

## Root cause

- `src/campaign/executor.ts:273` — the dependency-held resume itemRecord is pushed as
  `{ itemId, ticketId, lifecycleStatus: "pending", outcome: "held" }` with NO `blockerKind` and NO `reason`,
  unlike the readiness-held push (which stamps `blockerKind: "readiness"`). The newly-held dependency push
  earlier in the loop (the `blockedItems.length > 0` branch) has the same omission.
- `src/cli/commands/campaign.ts:351-361` — the resume paused handler only branches on `readinessHeld`
  (`outcome==='held' && blockerKind==='readiness'`) and `blocked` (`outcome==='blocked'`). A dependency-held
  record matches neither and falls through to the generic "resume again" message. The upstream failed+blocked
  item (FG-901) is skipped as terminal during resume, so it is not in `itemRecords` either — the `blocked`
  filter is also empty.

The `start` paused handler (campaign.ts ~247) has the same structure and the same dependency-held gap.

## Goal

A campaign paused with a dependency-held item tells the operator the truth: the item is held pending an
unresolved upstream blocker; resolve that blocker (see `forge campaign show`/`report`) then resume — not
"run resume again".

## Acceptance Criteria

- Dependency-held itemRecords carry enough context for the CLI to distinguish them from a plain
  between-items pause — at minimum carry the `reason` (e.g. "held because related to blocked item FG-901")
  on `CampaignItemRecord`, and/or a marker the CLI can branch on. (Readiness-held already carries
  `blockerKind: readiness`; dependency-held has no intrinsic blockerKind of its own, so prefer carrying
  `reason`.)
- `forge campaign resume` paused output, when a dependency-held item remains, names the held item(s) and
  instructs the operator to resolve the upstream blocker (pointing at show/report) then resume — NOT
  "run resume again".
- `forge campaign start` paused output has the same correct behavior for the dependency-held case.
- The existing readiness-held and failed+blocked messages are unchanged; co-occurrence ordering is sensible.
- Tests: a CLI integration test reproducing the repro above (FG-901 failed+blocked, FG-902 dependency-held)
  asserts the resume human output does NOT say "run resume again" and DOES surface the dependency-held
  item + resolve-blocker guidance. Cover both start and resume.

## Non-Goals

- Do not change FG-393 hold/continue policy semantics — only how a dependency-held pause is surfaced to the
  operator.

## Relations

- Follow-up to FG-413 (which fixed the readiness-held surfacing in the same handlers but did not address the
  pre-existing dependency-held generic message). Surfaces FG-393 (dependency hold) / FG-394 (operator
  truthfulness, shared-helper consistency).
