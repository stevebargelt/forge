---
id: FG-354
type: story
status: active
title: "persistence-check adaptation (FG-345 child 4): assert files_modified under the worktree path, not run.projectDir"
created: 2026-06-22
---

**Parent:** FG-345. **Depends on:** FG-351 (needs Task.worktreePath). **Sequence tightly with FG-351** — without this, every worktree rw agent false-positives as "work not persisted."

`checkResultPersistence(projectDir, result)` (src/v2/persistence-check.ts:25) calls `existsOnHost(projectDir, f)` with `run.projectDir` — the MAIN path. With worktrees the agent writes to the worktree; those files don't appear under `run.projectDir` until AFTER merge. So every rw agent with `files_modified` would fail spuriously.

## Scope
- Thread the task's `worktreePath` into the persistence-check call sites (runNext.ts:363 for the primary, invoke.ts:459). The function itself needs no change — it just needs the right root.
- Confirm the check still works for non-worktree fallback mode (`FORGE_NO_WORKTREES=1`) using `run.projectDir`.

## Acceptance
- A worktree rw agent that writes files passes persistence-check (asserted against the worktree path).
- Fallback mode still asserts against `run.projectDir`.
- forge-test green incl. a regression test that would fail under the old `run.projectDir` assumption.

Refs: src/v2/persistence-check.ts:25, runNext.ts:363, invoke.ts:459.
