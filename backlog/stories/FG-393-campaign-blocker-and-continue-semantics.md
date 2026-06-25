---
id: FG-393
type: story
status: active
title: Campaign blocker and continue semantics
epic: FG-370
created: 2026-06-24
---

## Problem

The campaign runner must know when to continue after a blocked item and when to stop because the blocker affects later work. A naive loop will either stop too often or run into known-bad dependent work.

## Goal

Define and implement conservative blocker handling for campaign items.

## Acceptance Criteria

- Record blocker reason, blocker type, and requested human action on the campaign item.
- Continue to the next item only when the next item is independent or explicitly marked safe to continue.
- Stop or hold later items when the blocker affects the backlog model, shared infrastructure, branch/merge state, dependency installation, auth, tests, or another named prerequisite.
- Continue to unrelated items when a blocker is local product/scope/acceptance criteria for one ticket and no dependency relation is known.
- Hold later items by default when dependency relation is unknown, unless the approved campaign mode explicitly allows pilot/continue behavior.
- Preserve skipped/held items with a clear reason.
- Support manual resume after the blocker is resolved.
- Do not create separate campaign-only item statuses for blocked/held/skipped if FG-390 can reuse the existing lifecycle vocabulary.
- Distinguish campaign outcomes and policies beside lifecycle status:
  - `outcome=blocked`: this item hit a problem.
  - `outcome=held`: this item did not run because an earlier blocker may affect it.
  - `outcome=skipped`: the operator or planner intentionally excluded it.
  - `continue_policy=continue_allowed`: later independent items may proceed.
  - `continue_policy=hold_dependents`: dependent or unknown later items must wait.
  - `continue_policy=hold_campaign`: the whole campaign must pause.
- Hold the campaign for shared infrastructure, backlog model, git/auth/dependency/test harness, campaign runner, or merge-state failures.
- Continue may be allowed for local scope/readiness/test/merge blockers only when later items are independent or explicitly approved for pilot continuation.
- Tests cover independent continuation, dependent hold, unknown-dependency hold, explicit pilot continuation, and manual resume.

## Non-Goals

- Do not solve deep dependency inference perfectly.
- Do not auto-resolve merge conflicts.
- Do not override Shipping Reviewer or done-audit blocks.
