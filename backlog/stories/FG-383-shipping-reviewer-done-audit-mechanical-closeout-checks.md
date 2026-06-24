---
id: FG-383
type: story
status: active
title: "Shipping Reviewer done-audit mechanical closeout checks"
epic: FG-372
created: 2026-06-23
---

## Problem

Forge can truthfully say tests passed while still being operationally unfinished: backlog close state uncommitted, dirty git status, missing push, skipped host verification, or deferred work not named.

## Goal

Add deterministic closeout checks that must pass before Forge may report `shipped` or `done` for mutating work.

## Acceptance Criteria

- Check `git status` and block shipped/done on unexpected dirty state.
- Check intended source, test, docs, and backlog changes are committed.
- Check backlog close/move state is committed when the item is being closed.
- Report pushed/not-pushed status when the orchestrator claims pushed work.
- Run or verify required host commands: typecheck, full suite, and workspace/package-specific tests when relevant.
- Distinguish host verification from container verification.
- Block shipped/done when required host verification fails or is skipped without accepted exception.
- Require named deferrals and linked follow-up backlog items when scope is intentionally deferred.
- Tests cover uncommitted backlog close state, failing required host verification, and clean closeout.

## Non-Goals

- Do not implement the LLM reviewer judgment.
- Do not solve dependency parity; FG-376 handles reviewer/agent containers running normal tests.
- Do not require PR creation; FG-367 covers broader git discipline.

## Relations

- Child of FG-372.
- Related to FG-367, FG-376, and FG-380.

