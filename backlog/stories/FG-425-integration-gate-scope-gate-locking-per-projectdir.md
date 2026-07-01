---
id: FG-425
type: story
status: active
title: "Integration gate: scope gate locking per-projectDir so long host gates cannot race across runs"
created: 2026-07-01
---

## Problem

FG-357's integration gate runs the project's full test:unit suite (default up to ~10 minutes) on the HOST against the shared `run.projectDir` checkout, after the worktree merge has landed on HEAD. Forge's run locking is scoped per-`runId`, not per-`projectDir`. So while one run holds HEAD in a merged-but-being-verified state and runs a long test suite, another run targeting the same `projectDir` is not excluded — widening an existing race window from the duration of a fast git merge to the duration of a full test-suite run. Concurrent runs on the same project could interleave merges/gates against a moving HEAD.

## Goal

Ensure a long-running host integration gate cannot race with another run operating on the same `projectDir`.

## Acceptance Criteria

- Integration-gate execution (and the surrounding merge→gate→finalize window) is mutually excluded across runs that target the same `projectDir`, not only within a single `runId`.
- The exclusion scope is documented and the lock is released deterministically on gate pass, gate fail (`integration_failed`), and crash/timeout.
- A test demonstrates that a second run targeting the same `projectDir` waits (or fails fast with a clear reason) while the first run's gate holds the project.
- No regression to independent runs targeting DIFFERENT `projectDir`s (they must still proceed in parallel).

## Relations

- Follow-up to FG-357 (post-merge integration gate). The gate lengthens the exposure of a pre-existing per-`runId` (not per-`projectDir`) locking limitation.
