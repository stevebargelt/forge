---
id: FG-612
type: story
status: active
title: "forge-on-forge dispatch guard: refuse to dispatch agents against the live forge source checkout when worktree mode is off"
created: 2026-07-24
---

## Why

Hit live on 2026-07-24 during FG-607. The orchestrator dispatched `forge new feature --project /Users/stevebargelt/code/forge`
with `FORGE_WORKTREES` unset, so the engineer container wrote directly into the checkout that IS the running forge.
`bin/forge` execs node with tsx loaded in-process over `src/` (FG-569) — there is no meaningful `dist/` — so every
half-written file was immediately live for every forge process on the host, in every project. A concurrent
meatgeekv2 orchestrator session found `forge new` broken mid-write (`setBacklogMode` / `ModeSetRefusal` referenced
before they were written) and was one keystroke from `git stash`-ing an ACTIVE build's in-flight work as "stray WIP".

Nothing in forge prevented this. The worktree machinery to avoid it has existed since FG-351/FG-352 — it was simply
not armed, and arming it is an unenforced convention.

## Scope

- Detect self-host dispatch: the resolved `--project` (realpath) is the source root of the forge that is executing.
- When self-host AND `isWorktreeModeEnabled()` is false (`src/v2/worktree-lifecycle.ts:42-43`), REFUSE before any
  container starts, naming the fix (`FORGE_WORKTREES=1`) and the kill switch (`FORGE_NO_WORKTREES=1`) as the explicit
  acknowledged override.
- Applies to every agent-spawning entry: `forge new`, `forge invoke`, `forge next` dispatch, `review-loop` fixer
  dispatch. A read-only red is still a write risk to the host source only via the shared mount, so gate on dispatch,
  not on role.
- Refusal must be fail-closed and pre-container — after the first file is written the damage is done.

## Acceptance Criteria

- Dispatching any agent against the live forge source with worktree mode off refuses, names both env vars, and
  creates no container and no task row.
- The same dispatch with `FORGE_WORKTREES=1` proceeds.
- The same dispatch with `FORGE_NO_WORKTREES=1` proceeds (explicit operator override, warns loudly).
- A dispatch against any OTHER project is unaffected (no new refusal path for normal use).
- Self-host detection resolves symlinks and works when forge is invoked via the npm-link symlink on PATH.

## Dependencies / Relations

- Relates to FG-345 (worktrees for all agents — parent) and FG-356 (orphan worktree cleanup, the reason worktree
  mode is not yet default).
- Does NOT depend on either: the guard is valuable while worktree mode remains opt-in, and becomes a cheap
  invariant check once it is default.

## Non-Goals

- Does not flip `FORGE_WORKTREES` to default (that is FG-345's call, gated on FG-356).
- No changes to worktree lifecycle, merge-back, or cleanup.
