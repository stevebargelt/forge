---
id: FG-467
type: story
status: done
title: "review-loop: add CLI integration test for the closeout_guidance_only branch (console message + exitCode=1) in registerReviewLoop"
created: 2026-07-05
closed: 2026-07-05
---

## Problem
The `closeout_guidance_only` stop reason (FG-462) has no CLI-level integration test. `registerReviewLoop`'s action prints a dedicated "not closeable — closeout_guidance_only ..." message and sets exitCode=1 for that branch; only the pure engine (runReviewLoop) and the reviewTask/fixTask prompt strings are covered.

## Severity
Low / test-coverage. The console branch is trivial (console.log + exitCode). Surfaced by FG-462 review-loop run-2 (run-review-loop-fg-462-7ca9d6), round-2 finding.

## Acceptance
- An integration test drives `registerReviewLoop` (injected invokeFn returning a reviewer verdict whose only finding is closeout for the ticket under review) and asserts the closeout_guidance_only console message + process.exitCode===1.

## Reference
src/cli/commands/review-loop.ts registerReviewLoop (closeout_guidance_only branch). FG-462.