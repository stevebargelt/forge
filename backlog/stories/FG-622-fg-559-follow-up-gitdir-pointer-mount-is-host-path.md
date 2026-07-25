---
id: FG-622
type: story
status: active
title: "FG-559 follow-up: gitdir pointer mount is host-path-only — a RELATIVE pointer (submodules, git>=2.48 relative worktrees) never resolves in-container"
created: 2026-07-25
---

## Context

Found by the test-engineer verify pass on FG-559 (`run-fg-559-a-b-worktree-git-access-a3f409`).
**Not a regression** — it is a limitation of what FG-559 shipped, and it fails LOUDLY (container probe,
exit 122) rather than silently, which is the failure mode FG-559 existed to eliminate. Filed as
follow-up rather than fixed in FG-559 because a submodule project is not a linked worktree, so it
falls outside that ticket's acceptance criteria.

Pinned as a characterization test (`src/v2/fg559-worktree-git-enforcement.worktree.test.ts` —
*"a RELATIVE gitdir: pointer is resolved against the HOST path"*) so it cannot quietly regress into a
silent failure.

## Problem

`planWorktreeGitMounts` resolves the `gitdir:` pointer with `resolve(projectDir, target)` and returns a
HOST absolute path, which `buildDockerArgs` then binds at that host path. That is correct for a
standard `git worktree add`, whose `.git` pointer is ABSOLUTE.

It is **not** correct when the pointer is RELATIVE. The project is bind-mounted at `/project`, so a
pointer of `../.git/modules/sub` resolves IN-CONTAINER to `/.git/modules/sub` — a path the host-path
bind never covers, and which the container never looks up.

Two real cases:

1. **Every git submodule.** Verified in-container: `git submodule add` writes exactly
   `gitdir: ../.git/modules/sub`, and `planWorktreeGitMounts` happily returns `<super>/.git/modules/sub`
   for it.
2. **`git worktree add --relative-paths` / `worktree.useRelativePaths`** on git >= 2.48. The verifying
   container has git 2.34.1, so this spelling could not be exercised directly — the relative pointer was
   constructed by hand instead. **Worth re-verifying against a real git >= 2.48 before fixing.**

## Consequence

`assertWorktreeGitMountPlanned` ACCEPTS the argv, because the plan it computed WAS mounted. So the
host-side guard's actual guarantee is *"the plan I computed was mounted"*, not *"the container can
resolve the pointer"*. Only the container-side probe catches it, exiting 122.

That is a meaningful narrowing of what FG-559's piece A appeared to promise, and it is worth stating
plainly: the host check and the container check are NOT redundant — the container probe is load-bearing
for this case, not a belt-and-braces backstop.

## Also in scope — two guard-contract overstatements found in the same pass

Both are documentation/message defects, not behavior defects. Fixing them here keeps the guard's stated
contract aligned with what it actually does.

1. **`readGitdirPointer`'s doc comment claims submodule support** — *"a linked worktree's (or
   submodule's) .git POINTER FILE"*. It reads the pointer correctly for a submodule, but the resulting
   MOUNT does not achieve anything for one. The comment overstates the outcome.
2. **`assertWorktreeGitMountPlanned`'s "no false-positive class" comment is overstated.**
   `isIdentityMountPlanned` parses each `-v` spec with `split(":")`, so a parent `.git` whose host path
   contains a colon (legal on Linux and macOS) never matches `host === container`, and `buildDockerArgs`
   throws the FG-559 refusal on an otherwise-valid worktree. Refusing is arguably the RIGHT outcome —
   docker's `-v host:container:mode` cannot express such a path either, so the dispatch could not work
   regardless — but the message misattributes the cause: it says *"the docker mount plan does not bind
   at its own host path"* when the real cause is *"this host path cannot be expressed as a docker bind"*.

## Non-goals

- Do NOT make the parent `.git` writable — that is FG-621 and gated on an FG-345 decision.
- Do NOT change the `:ro` policy or the accepted red read-surface (recorded in FG-559).

## Acceptance criteria

- A project whose `.git` pointer is RELATIVE resolves git in-container, OR is refused host-side with an
  accurate message naming the relative-pointer cause. Silent non-resolution is not acceptable either way.
- Submodule case verified end-to-end, not by hand-constructed fixture alone.
- `worktree.useRelativePaths` / `--relative-paths` re-verified against a real git >= 2.48 before the fix
  is designed — the current evidence for that spelling is a hand-built pointer, not the real thing.
- The characterization test from FG-559 is updated (not deleted) to assert the new behavior.
- `readGitdirPointer`'s comment no longer claims an outcome for submodules that the mount does not
  deliver.
- The colon-path refusal message names the real cause.
