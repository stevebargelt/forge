---
id: FG-406
type: story
status: active
title: Tier Forge test suites into unit, integration, worktree, and aggregate gates
created: 2026-06-24
---

## Problem

Forge's root `npm test` is currently a full host regression suite, not a pure unit suite. It mixes cheap pure tests, CLI subprocess tests, filesystem/DB integration tests, and git/worktree control-plane integration tests into one command via `find src -name '*.test.ts'`. That makes local iteration slower than necessary and makes it harder for agents to choose the right verification level for a change.

## Goal

Introduce explicit test tiers so humans, Forge agents, and future Campaign Runner flows can run the smallest appropriate suite during iteration while preserving a full aggregate gate before shipped claims.

## Decided mechanism (2026-06-24)

Selection is by **filename suffix** (glob-based), because `node:test` has no marker/tag selector and the suite is already co-located next to source and already uses `*.integration.test.ts`. Extending that existing convention is lower-churn and more idiomatic for `node:test` than a directory move (which would relocate ~32 files and break co-location). This is consistent with established suffix conventions (Maven Failsafe `*IT`, Jest `*.ispec`).

Three suffixes, three tiers, plus an aggregate:

- **unit**: `src/**/*.test.ts` EXCLUDING `*.integration.test.ts` and `*.worktree.test.ts`. Fast, pure, in-memory. No subprocess spawn, no git, no real-fs/DB churn, no sleeps.
- **integration**: `src/**/*.integration.test.ts` EXCLUDING `*.worktree.test.ts`. CLI subprocess spawn, real filesystem, real SQLite, boundary tests.
- **worktree / control-plane**: `src/**/*.worktree.test.ts`. Git worktree creation, dispatch/merge-back orchestration state machine, expected-slow control-plane tests. Reclassify the existing v2 worktree/dispatch integration files to this suffix (candidate set, VERIFY BY CONTENT not just name: fg351-dispatch, fg351-worktree-lifecycle, fg352-dispatch, fg352-auto-commit-reds, fg353-dispatch, fg354-dispatch, fg354-persistence-worktree, fg374-project-mount). The criterion is: spawns git worktrees OR exercises the fanout/merge-back orchestration path OR is expected-slow control-plane — not merely "is an integration test".

Recommended npm scripts (engineer may refine names, keep `test` backward-compatible):
- `test` — root aggregate (all three tiers); preserves today's full coverage so no existing caller breaks.
- `test:unit`, `test:integration`, `test:worktree` — the individual tiers.
- `test:all` — root aggregate PLUS the dashboard workspace suite (the shipped-claim gate).

## Acceptance Criteria

- `test:unit` excludes subprocess-heavy, git/worktree, and long-running integration tests (suffix-excluded as above).
- `test:integration` runs CLI-spawn / real-fs / real-DB boundary tests, excluding the worktree tier.
- `test:worktree` runs the git-worktree / orchestration control-plane tests.
- An aggregate command runs all required root AND dashboard tests; it is the only gate for shipped claims.
- `test` either preserves today's full-suite behavior or is replaced with a clearly documented equivalent — no existing caller silently loses coverage.
- The suffix convention makes tier ownership obvious enough for agents to place new tests correctly; document it.
- Documentation explains when to use each tier and states that long-running tests must not be added to the unit tier.
- The tiering change deletes NO valuable regression coverage: the sum of the three tiers equals the current root suite (assert this — e.g. a test or a documented count check that unit+integration+worktree == the old full glob).

## Non-Goals

- Coverage reporting — FG-405 owns that.
- Changing what agents run by default and the implementer-seed prose — FG-407 owns the agent-iteration ergonomics (depends on this ticket landing the tier commands first).

## Notes

Prerequisite for reliable overnight/campaign execution ergonomics: agents need a fast local loop and a final full gate. FG-405 covers coverage reporting; FG-407 covers routing agents to the fast tier; this ticket covers suite shape and command routing.
