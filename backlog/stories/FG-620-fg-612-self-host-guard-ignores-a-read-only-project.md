---
id: FG-620
type: story
status: active
title: FG-612 self-host guard ignores a read-only project mount — refuses --read-only dispatches that cannot write to the checkout
created: 2026-07-25
---

## Problem

`assertSelfHostDispatchAllowed` refuses a self-host dispatch based solely on `(projectDir, sourceRoot)`
overlap plus worktree-mode state. It never consults the project MOUNT MODE, so it refuses dispatches
that are structurally incapable of the hazard it names.

`src/v2/self-host-guard.ts:81`

```ts
export function assertSelfHostDispatchAllowed(projectDir: string, sourceRoot = forgeSourceRoot()): void {
  if (!isSelfHostDispatch(projectDir, sourceRoot)) return;
  if (isWorktreeModeEnabled()) return;
  ...
```

The refusal text states the hazard explicitly: *"Agents write into the shared project mount when
worktree mode is off, and forge runs src/ in-process (FG-569) — a half-written file is immediately
live for every forge process on this host."*

But a `--read-only` dispatch mounts the project `:ro` at the OS level — `src/v2/spawn.ts:462`:

```ts
args.push("-v", `${ctx.PROJECT_DIR}:${projectContainerPath}:ro`);
```

An agent under a `:ro` mount cannot write a partial file into the checkout. The premise of the
refusal does not hold for that dispatch class.

## How it surfaced (2026-07-25)

Dispatching the FG-559 design pass — `forge invoke architecture-advisor --read-only --project <the
forge checkout>` — was refused. The two remedies the message offers are both wrong for this case:

- `FORGE_WORKTREES=1` puts the agent on a linked worktree, which is **exactly the FG-559 defect**
  (no working git in the container). For an architecture pass whose brief requires running
  `git clone` / `git worktree add` experiments, this actively breaks the work.
- `FORGE_NO_WORKTREES=1` proceeds, but emits a warning that is **factually wrong** under `:ro`:
  *"Agents are writing to the source tree this forge is executing; partial writes are live for every
  forge process on this host."* Nothing is writing.

So the only available path makes the operator acknowledge a hazard that cannot occur, and trains
them to wave past a guard that is correct in the read-write case.

## Why it matters

Read-only dispatch is the normal mode for the whole adversarial/advisory population — reds,
`architecture-advisor`, audit invokes. Forge-on-forge review and design work is routine here. A guard
that fires on the safe class dilutes the signal for the genuinely dangerous class (an `engineer`
writing into the live `src/`), which is the one the operator most needs to take seriously.

## Direction (not decided)

Thread the resolved project mount mode into the guard and return early when the mount is `:ro`,
the same way `isWorktreeModeEnabled()` returns early. Mount mode is resolved from the
`--read-only` flag; the guard is called pre-container and pre-row, so the flag is already known at
the call site — confirm that before assuming it.

Consider also whether the `FORGE_NO_WORKTREES=1` warning text should be conditioned on mount mode,
since it asserts writes that a `:ro` mount forbids.

## Acceptance criteria

- A self-host dispatch with a read-only project mount is NOT refused and emits no write-hazard
  warning.
- A self-host dispatch with a read-write project mount is still refused exactly as today
  (regression — the FG-612 guard must not be weakened for the class it was built for).
- `FORGE_NO_WORKTREES=1` on a read-write self-host dispatch still warns; the warning text does not
  claim writes are happening when the mount is `:ro`.
- Tests cover both mount modes explicitly. A test that only exercises the read-write path would pass
  vacuously against this bug.
