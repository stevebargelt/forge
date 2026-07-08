---
id: FG-500
type: story
status: active
title: "host-run gate evidence can ship on the fast tier only: requiredHostGate host rows + reconcile/review-loop no-CI fallbacks bypass the extended tier (FG-495 gap, host branch)"
created: 2026-07-08
---

## Problem

FG-495 shrank `npm run test:all` to the fast tier and f59b47b hardened the CI branch of `findCoveringGateEvidence` (whole workflow green at the sha). But the HOST branch of the evidence model still equates "the deterministic gate" with the single `requiredHostGate` string (default `npm run test:all`):

- src/store/host-verifications.ts:392 — a passing host row at exact sha + `npm run test:all` is accepted BEFORE the CI check; a fast-tier-only row satisfies reuse.
- src/campaign/reconcile-collect.ts:391 — reconcile's real-exec fallback runs only requiredHostGate and records that row; done-audit (src/done-audit/collect.ts:142) then ships on it.
- src/v2/review-loop.ts:263 — the loop's no-reuse fallback verification runs only `typecheck` + `test` (unit tier post-FG-495) and can declare closeable.
- `forge record-host-verification` with `npm run test:all` likewise mints shippable evidence proving no integration/worktree coverage.

Net: whenever CI evidence is absent, an item can reach shipped/done-audit-pass/closeable without the extended tier — reopening the trust gap FG-495's "extended tier is required" disposition closed on the merge path. (Operator-reported finding, 2026-07-08; all four sites verified.)

## Goal

The required host-evidence model covers the FULL deterministic set, not just the fast gate, whenever CI evidence is absent. Whole-workflow-green CI evidence continues to cover everything (it already proves every job).

## Fix shape (adapt to code reality)

- A derived required-gate LIST per project: `[requiredHostGate]` + `npm run test:extended` when the gate is the default AND the project's package.json has a `test:extended` script. Projects with a custom configured gate or no extended script keep single-gate behavior (no new false blocks on other managed projects).
- Exact-sha reuse (findCoveringGateEvidence): host-row coverage requires a passing row for EVERY list member at the sha; whole-workflow CI green covers all members as today.
- Reconcile real-exec fallback: runs and records every list member (fail-closed on first failure, same refusal semantics per command).
- done-audit host_verification: ancestry coverage requires all list members covered by passing host rows, OR a ci-sourced passing covering row (whole-workflow semantics).
- Review-loop no-reuse fallback verification: also runs `test:extended` when the script exists.

## Acceptance criteria

- [ ] A passing `npm run test:all` host row alone (no extended coverage, no CI evidence) does NOT satisfy exact-sha reuse, reconcile capture, or done-audit on a project with a test:extended script — negative tests through the real paths for all three consumers.
- [ ] Reconcile's real-exec fallback runs and records both gates; a failing extended run blocks exactly like a failing fast run.
- [ ] Review-loop fallback verification includes the extended tier when the script exists; reuse via CI/host evidence unchanged.
- [ ] A ci-sourced passing row (whole-workflow green) satisfies the full list (no double-charging CI).
- [ ] Single-gate projects (no test:extended script, or custom requiredHostGate) behave exactly as today — regression tests.
- [ ] docs/concepts.md host_verification + evidence-reuse sections reconciled.

## Refs
- FG-495 (tiering), f59b47b (CI-branch whole-workflow fix — this is its host-branch sibling), FG-419/FG-440 (gate-evidence spoofing lineage).
