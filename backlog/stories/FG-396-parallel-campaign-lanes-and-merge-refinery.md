---
id: FG-396
type: story
status: active
title: "Parallel Campaign lanes and merge/refinery behavior"
epic: FG-370
created: 2026-06-24
---

## Problem

Parallel campaign work is valuable, but unsafe parallelism can create merge conflicts, hidden dependency failures, and misleading closeout. Parallel lanes need explicit isolation, integration, and validation rules.

## Goal

Design and implement parallel campaign lanes after the sequential runner is proven.

## Acceptance Criteria

- Define the evidence required before two campaign items may run in parallel.
- Each parallel item runs in an isolated branch/worktree.
- Completed items merge through an explicit ordered integration/refinery process.
- Merge conflicts are recorded as item or integration blockers, not silently resolved.
- Integrated output is validated before any campaign-level success claim.
- Dashboard/CLI surfaces explain lane state, merge state, and blocked integration state.
- Tests cover safe parallel dispatch, conflict retention, ordered integration, and post-merge validation failure.

## Non-Goals

- Do not ship before worktree dependency parity and post-merge integration gates are reliable.
- Do not make parallelism the default for low-evidence campaigns.
