---
id: FG-612
type: story
status: done
title: "forge-on-forge dispatch guard: refuse to dispatch agents against the live forge source checkout when worktree mode is off"
created: 2026-07-24
closed: 2026-07-25
closed_commit: 066aab2
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

## Acceptance Evidence

Shipped in `066aab2`, merged to main 2026-07-24. Required CI green at that commit: `test` and `test-extended`
(all six member jobs).

| AC | Evidence | Verdict |
|---|---|---|
| Self-host dispatch with worktree mode off refuses; no container, no task row | `src/v2/self-host-guard.ts` + guards in `invoke.ts`, `runNext.ts`, `cli/commands/new.ts`. `src/v2/fg612-self-host-dispatch.integration.test.ts` counts container-exec calls, so "pre-container" is asserted rather than inferred from an exit code. **Scope stated precisely:** no task directory, `manifest.json`, staged auth, worktree, or container on ANY path. For `forge next` the step ROW is minted by the ready queue BEFORE dispatch — control-plane state only, not created by the dispatch, and predating this ticket. Four of five paths are additionally pre-row. | met (with the `forge next` row scope stated) |
| The same dispatch with `FORGE_WORKTREES=1` proceeds | Covered in both test files; every refusal assertion is paired with a negative control dispatch under the same fixture | met |
| The same dispatch with `FORGE_NO_WORKTREES=1` proceeds, warning loudly | Covered in both test files. Also verified live by hand: the override started `forge-task-engineer-97adb7` against the forge repo | met |
| A dispatch against any OTHER project is unaffected, in every env-var combination | Negative controls in both files; a sibling directory whose path merely shares a string PREFIX is asserted NOT to refuse | met |
| Detection resolves symlinks (npm-link binary, `/var` → `/private/var`) | `src/cli/fg612-self-host-cli.integration.test.ts` drives the real `bin/forge` as a subprocess — the only place the npm-link symlinked-binary case is genuine. **Mutation-proven load-bearing:** removing path canonicalization fails ONLY these two symlink tests, i.e. they are the sole detector of the decorative-guard failure mode | met |

**Coverage beyond the written AC**, found by the implementer rather than specified by me: `forge retry` reaches a
container via `src/v2/retry.ts -> dispatchInvokeTask()` WITHOUT passing through `invoke()` — a fifth entry point.
Guarded, and after a follow-up round the guard sits ahead of `writeTaskManifest`/auth staging/`buildDockerArgs`
so a refused retry leaves no debris. Detection was also widened to overlap in EITHER direction (project is,
contains, or sits under the source root).

**Suite verified by mutation testing**, not by being green: removing canonicalization → only the symlink tests
fail; narrowing overlap to equality → only the parent-dir and subdir tests fail; never refusing → 10/14 and 8/11
fail; moving the guard after the run row → only the four traceless tests fail. Backups md5-verified on restore.

**Live proof it works:** the guard refused its own author's first dispatch after landing (a test-engineer invoke
where the override was set on the launcher instead of inside the launched command), pre-container, naming the fix.
