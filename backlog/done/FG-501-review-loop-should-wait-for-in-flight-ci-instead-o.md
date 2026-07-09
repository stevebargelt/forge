---
id: FG-501
type: story
status: done
title: review-loop should wait for in-flight CI instead of starting duplicate local verification
created: 2026-07-09
closed: 2026-07-09
closed_commit: 41334a9
---

## Problem

FG-474 and FG-495 were meant to make deterministic verification run once per reviewed commit: CI owns the required checks, and review-loop reuses covering evidence instead of re-running the same suites locally.

In practice, the review-loop only reuses CI evidence after it is already green. If a PR has just been opened or updated, GitHub Actions starts the required checks, but `forge review-loop` sees no completed green evidence yet and immediately falls back to local verification. That means CI and review-loop run the same tests at the same time. The operator then waits 10-12 minutes per review pass for duplicated verification.

This is now a major autonomous-run throughput bug. It is not enough that CI evidence can be reused after completion; review-loop must recognize in-flight CI and wait for it rather than start duplicate local work.

## Evidence

- `src/cli/commands/review-loop.ts` `verifyWithReuse` checks for covering gate evidence, but falls back to `runVerification(...)` when evidence is absent.
- `src/v2/review-loop.ts` `runVerification` can run `typecheck`, `test`, and `test:extended` locally.
- `.github/workflows/ci.yml` already runs required `test` and `test-extended` checks for the same commit.
- Operator-observed 2026-07-08: every review pass waits while CI starts tests and review-loop starts tests too, adding roughly 10-12 minutes of duplicate waiting.

## Goal

Make review-loop consume CI as the verification authority for PR-reviewed commits, including pending/in-progress checks. Local verification is a fallback for missing/unavailable CI, not the default path while CI is already running.

## Acceptance Criteria

- [ ] For a reviewed commit whose required CI checks are pending or in progress, `forge review-loop` waits/polls for those checks instead of invoking local `runVerification`.
- [ ] If the required CI checks pass, review-loop proceeds to the reviewer with `verification.reusedEvidence` describing the CI check names and URLs.
- [ ] If any required CI check fails, review-loop reports deterministic verification failure from CI evidence, including the failing check name and URL, without starting duplicate local tests.
- [ ] If CI status is unavailable, not configured, or cannot be queried, review-loop falls back to local verification with an explicit message explaining why.
- [ ] The normal PR review-loop path does not locally run `test:extended`; extended coverage belongs to CI unless a user explicitly requests local fallback/extended verification.
- [ ] Operator output while waiting is visible and specific: reviewed SHA, required check names, current status, elapsed wait, and URL when available.
- [ ] Tests cover: pending CI eventually passes without local verification; failed CI stops as verification_failed without local verification; unavailable CI falls back locally; reused CI evidence appears in the review-loop report.

## Non-Goals

- Does not weaken required CI checks or branch protection.
- Does not remove local verification as an emergency fallback.
- Does not change the test tiering itself; FG-495 owns what belongs in fast vs extended tiers.
- Does not solve dashboard visibility of CI status, except for review-loop CLI/operator output.

## Priority / Sequencing

Batch after FG-494 if possible. FG-494 fixes notification delivery; this fixes the biggest current review-loop latency tax. Together they improve unattended/autonomous runs without touching the FG-491 persistence-watchdog branch.
