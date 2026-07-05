---
id: FG-436
type: story
status: done
title: Orchestrator should default implementation work to bounded review-loop
created: 2026-07-02
closed: 2026-07-05
closed_commit: e5f8e65
---

## Problem

The orchestrator asks the operator to choose between a bounded automated review-loop and direct human PR review after implementation work has landed. This treats an established quality gate as an operator preference and keeps the human as a routine final PR reviewer even when automated review, deterministic verification, and CI have already passed.

Observed outside Forge on FW-16: the orchestrator offered:

- Option A: bounded `forge review-loop FW-16 --max-rounds 2 --route implementation_quick`
- Option B: human PR review only

For code or durable-behavior implementation work, Option A should be the policy-derived default. Once the bounded review-loop passes, deterministic verification is green, and required CI checks pass, the orchestrator should be allowed to merge without waiting for a separate human PR review.

## Goal

Make bounded review-loop the default route for landed implementation work and make passing automated quality gates sufficient for merge. The human remains responsible for product direction and exceptions, but is not a routine final PR reviewer when the configured gates pass.

## Acceptance Criteria

- For implementation work that changes code or durable behavior, the orchestrator selects bounded review-loop by default before declaring work merge-ready.
- The orchestrator still presents the exact commit/range, reviewer/fixer roles, max rounds, verification commands, CI checks required, and stop conditions before starting the loop.
- The orchestrator does NOT ask the operator to choose between review-loop and human PR review when policy already says review-loop is required/default.
- A passing review-loop plus deterministic verification plus green required CI checks is sufficient authorization to merge the PR automatically.
- The orchestrator does not wait for a separate human PR review after all required automated gates pass.
- Auto-merge is blocked when any required condition is absent or failing: review-loop exhausted without pass, tests/verification failed or missing, required CI not green, unresolved blocking reviewer findings, dirty/unpushed branch state, merge conflict, or stale PR branch that must be updated.
- The orchestrator may ask before skipping review-loop only for explicit exceptions: docs-only, backlog-only, trivial metadata, emergency/unblock work, or when the user explicitly requested skipping automated review.
- Include an example matching FW-16: after implementation lands on a branch/PR, select bounded review-loop with max rounds and route, show range/roles/stop conditions, run the loop, verify CI, and merge automatically when all gates pass.

## Non-Goals

- Does not skip bounded automated review for code or durable-behavior implementation work.
- Does not require review-loop for backlog-only or docs-only work unless the change also affects behavior or policy.
- Does not change reviewer severity disposition rules; see FG-432 for low-severity finding policy.
- Does not bypass branch protection or required CI.

## Relations

- Related to FG-432: review finding disposition after the loop runs.
- Related to FG-429: orchestrator should resolve policy-derived decisions rather than ask the operator to adjudicate routine process.
- Related to forge review-loop command/operator flow and PR merge automation.