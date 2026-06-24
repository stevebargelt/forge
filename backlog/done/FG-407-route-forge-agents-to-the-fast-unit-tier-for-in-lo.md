---
id: FG-407
type: story
status: done
title: Route Forge agents to the fast unit tier for in-loop iteration; orchestrator runs the aggregate gate before shipped claims (FG-406 follow-on)
created: 2026-06-24
closed: 2026-06-24
closed_commit: 060379a
---

## Problem

Today Forge agents verify by running the mixed root suite (`docker/forge-test.sh` defaults to "all tests"; the implementer seeds say "run forge-test"). That means every agent iteration runs CLI-subprocess, real-DB, and git/worktree control-plane tests it usually doesn't need, slowing the inner loop. With FG-406 splitting the suite into tiers, agents should iterate on the fast UNIT tier and let the orchestrator run the full aggregate gate before any shipped claim.

## Depends on

FG-406 (must land first — this ticket routes callers at the tier commands FG-406 defines).

## Goal

Make the fast unit tier the default verification level for in-loop agent iteration, while preserving the full aggregate gate as the bar for shipped/complete claims. Preserve full-gate coverage; stop making every agent iteration run the mixed root suite.

## Acceptance Criteria

- `docker/forge-test.sh` with no arguments runs the UNIT tier (FG-406 `test:unit`), not the full mixed suite. Passing an explicit file/pattern/flags still works unchanged (single-file runs, targeted tiers).
- An agent can still opt into a heavier tier explicitly (e.g. `forge-test --integration` / `forge-test --worktree`, or by invoking the tier script) — document the escape hatch.
- Implementer-seed prose (engineer / frontend-specialist / backend-specialist / security-advisor / agentic-platform-builder) is updated: agents validate in-loop with the unit tier (plus the specific integration/worktree tier when their change touches that boundary), NOT the whole mixed suite. The seeds must NOT imply the unit tier is sufficient proof for a shipped claim.
- Operator/agent docs state the contract explicitly: agents iterate on the fast tier; the orchestrator runs the aggregate (`test:all`) on the host before a run is called complete. This does not weaken the all-tests-pass gate — it relocates it to the aggregate, run by the orchestrator.
- No change to what the orchestrator's full-suite host gate runs (still the aggregate including dashboard).

## Non-Goals

- Defining the tier commands themselves (FG-406).
- Coverage reporting (FG-405).
- Changing the verdict/gate aggregation rules.

## Notes

This is the piece that actually delivers the "stop running the mixed suite every iteration" directive. Keep the seed wording precise: faster inner loop, same final bar. Relates to the standing rule that a failing test on a complete result is an automatic reject — that bar moves to the aggregate, it does not relax.
