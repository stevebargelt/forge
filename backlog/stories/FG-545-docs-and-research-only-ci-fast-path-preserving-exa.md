---
id: FG-545
type: story
status: active
title: Docs and research only CI fast path preserving exact-head required checks
created: 2026-07-12
---

## Problem

Forge's two required CI jobs run the full unit/dashboard and extended integration/worktree suites for every change, including branches whose complete diff contains only documentation, notes, or research Markdown. Repository-producing research should retain exact-head CI evidence and normal merge authorization, but it should not pay for unrelated executable tests when no executable surface changed.

Using workflow-level path exclusions is unsafe for Forge's trust model: a required check can be absent or remain pending instead of producing a successful verdict tied to the reviewed head.

## Goal

Add a fail-closed docs/research-only CI classification that preserves both required check contexts at the exact head while replacing unrelated test execution with explicit, auditable successful no-test paths.

## Acceptance Criteria

- CI classifies the complete change set against the authoritative PR base. For non-PR triggers, it uses a documented comparison that cannot omit commits in the pushed range.
- The fast path is eligible only when every changed path is under one of these allowlisted trees:
  - docs/**
  - notes/**
  - research/**
- Any path outside the allowlist selects normal CI. This includes source, tests, dashboard code, scripts, seeds, configuration, package manifests and lockfiles, workflow files, backlog tickets, and root-level files.
- Both required contexts, test and test-extended, still execute as jobs and report success for the exact head SHA. Do not use workflow-level paths-ignore in a way that leaves a required context absent, skipped ambiguously, or pending.
- Each fast-path job records the complete classified path set and a clear reason that executable tests were not run in the GitHub Actions step summary/log.
- Mixed docs/code changes fail closed to the normal test suites.
- Classification handles additions, modifications, deletions, renames across the allowlist boundary, unusual valid filenames, merge-base changes, and an empty/indeterminate diff. Ambiguous or failed classification runs normal CI.
- Changes to the classifier or CI workflow itself cannot qualify for the fast path.
- Forge review-loop CI reuse recognizes successful fast-path executions as paired exact-head evidence, while continuing to reject missing, unpaired, stale, or failed required checks.
- Tests cover allowlisted-only changes, every boundary/fail-closed case above, and the review-loop evidence-consumption path.
- Operator documentation explains which paths qualify and that the required checks still ran but intentionally omitted executable tests.

## Trust Constraints

- This is a test-selection optimization, not a waiver of required CI evidence.
- The decision must be derived from repository diff truth, not from the requested campaign lane, ticket type, commit message, or agent claim.
- Existing full-test behavior remains the fallback for every uncertain case.

## Relations

- Paired with FG-544 (orchestrator-owned concurrent research lane).
- Related to FG-474 and FG-495 (required CI gate and test-tier split).
- Related to FG-501 (review-loop reuse of exact-head CI evidence).
- Related to FG-396 (parallel campaign integration/refinery).
