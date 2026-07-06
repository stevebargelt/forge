---
id: FG-424
type: story
status: done
title: "Integration gate: distinguish real test failures from infra/platform failures in integration_failed classification + advice"
created: 2026-07-01
closed: 2026-07-06
closed_commit: 0c778c53417dac8dcf391015e6e23a7646086948
---

## Problem

FG-357's post-merge integration gate classifies ANY non-zero exit from the project's test:unit run as the terminal, non-retryable `integration_failed`, with operator advice that says "fix the code" and offers `git reset --hard HEAD~1`. That advice is correct for a genuine semantic test failure, but wrong for an infrastructure/platform failure (a test-runner timeout, OOM, an esbuild/native-module platform mismatch, or a stale scratch-cache artifact). During FG-357's own build the engineer observed a `/tmp/forge-work` caching artifact throwing 22 false-positive failures — demonstrating the infra-vs-real-failure conflation is observed, not theoretical. A false `integration_failed` from an infra hiccup blocks the merge as non-retryable and misdirects the operator toward a code fix that does not exist.

## Goal

Distinguish a genuine merged-tree test failure (broken integration → non-retryable, fix-the-code) from an infrastructure/platform failure (transient → retryable or a distinct classification), and give operator guidance that matches the actual cause.

## Acceptance Criteria

- The integration gate can tell a genuine test-suite failure apart from an infra/platform failure (e.g. via exit-code/signal inspection, known infra-error patterns, or a runner health probe) with a documented heuristic and its known false-negative bounds.
- An infra/platform failure is NOT silently classified as non-retryable `integration_failed` with "fix the code" advice; it is either retryable or a distinct kind with matching guidance.
- A genuine semantic test failure still classifies as non-retryable `integration_failed` (FG-357 behavior preserved).
- Negative test: an injected infra-style failure (non-test exit) does not produce the "fix the code" non-retryable path.

## Relations

- Follow-up to FG-357 (post-merge integration gate). Deferred from FG-357 as out of its core "catch cross-file breakage" scope.
