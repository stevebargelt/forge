---
id: FG-621
type: story
status: done
title: "Writable in-container git for agents: separate object store so an agent can commit without write access to the parent repo (FG-559 piece C)"
created: 2026-07-25
closed: 2026-07-25
---

## Context

Split out of FG-559's architecture pass (2026-07-25) as **piece C**. FG-559 ships pieces A + B: a
read-only bind mount of the parent `.git` gives every agent working `git log` / `git diff` / `git show`
on a linked worktree, and refuses loudly when the mount is missing.

**File it, do not build it.** This is gated on an FG-345 decision that has not been made.

## Problem

A linked worktree shares the parent's object store and ref namespace by construction — that is what
makes it cheap. So *"the agent can commit on its task branch"* and *"the agent cannot damage the
parent repo"* are **not simultaneously achievable** through the worktree's own `.git`, at any mount
granularity.

Proven during the FG-559 experiment:

- Whole parent `.git` mounted **read-write**: a container successfully created a branch in the parent
  repo. Incompatible with the red boundary (`docs/invariants.md` #9).
- **Scoped-write** (ro except `objects/` plus the task's own ref + reflog dirs): protects the ref
  namespace — `main`, `origin/*`, and packed refs all proven refused — but a writable `objects/` is a
  **deletable** `objects/`. The container can destroy the parent's history and every sibling worktree's
  basis. Also required four separately-scoped nested mounts, including a reflog directory that only
  surfaced by running it. Complexity with no boundary guarantee.

Worth stating plainly against FG-345's framing of worktrees as "OS-level write isolation":
**worktrees isolate the WORKING TREE, not the repository.** That distinction has been implicit, and
FG-559 is what exposed it.

## The decision this is gated on (FG-345)

`src/v2/worktree-lifecycle.ts:231-242` documents the contract:

> *Contract: agents are expected to commit their work on the task branch. As a safety net, this
> function auto-stages and commits any uncommitted changes in the worktree before merging.*

Host-side commit is the documented **safety net**, not the primary path. FG-559's read-only mount
deliberately prevents blue agents from committing, demoting that primary path to an always-unused one.
No work is lost — the safety net preserves the agent's filesystem changes — but the contract goes
stale on merge.

Before the FG-345 worktree default-on flip, one of these must be chosen explicitly:

1. **Declare host-side commit authoritative** under worktree mode and update the stale contract at
   `worktree-lifecycle.ts:231`. This ticket is then closed as won't-do.
2. **Build this ticket** — give agents a writable git — before default-on.

FG-559 must not silently resolve this by editing that comment.

## Direction if it is built

`git clone --shared` off a read-only-mounted parent `objects/` is the proven cheap form: measured
0.106s and <1MB new storage on this repo (alternates point back into the parent objects), full depth,
local commits work, parent remains unwritable.

It composes with FG-376 for free: a clone of the same commit has a byte-identical `package-lock.json`,
so `planDependencyVolumes` (`src/v2/dependency-provisioning.ts`) resolves the SAME lockfile hash and
the SAME already-populated volume `spawn.ts:323-372` mounts today. The `cp -R node_modules` half of the
proven disposable-clone workaround is redundant inside forge.

Merge-back would become `git fetch <clone> <branch>` + merge rather than `mergeWorktreeBranch`'s
`git merge --ff-only <branch>`. That re-plumbing is the real cost, and it is why FG-559 rejected
clone-as-the-default.

Other cases this unlocks, if they ever become requirements: in-container `rebase`, `bisect`,
`git apply`, `git stash`, and a red that must be denied the sibling ref namespace.

## Scope boundary

Applies per-agent-class and deliberately, never as the substrate. FG-559's read-only mount stays the
default for everyone; this is the escape hatch.

## Acceptance criteria

- Deferred pending the FG-345 decision above. Do not implement until that decision is recorded.
- If built: an agent can `git commit` on its task branch in-container, and a container write to the
  PARENT repo's refs or object store is still refused (negative test, not a comment).
- If built: merge-back retrieves the agent's own commits, with the host-side safety-net commit still
  covering the uncommitted case.

---

## Closed 2026-07-25 — decision folded into FG-345

This was a deferred design OPTION, not implementable work: it is gated entirely on FG-345 deciding whether host-side commit becomes authoritative under worktree mode, or agents get a writable git.

That decision, with the FG-559 evidence behind it (the `worktree-lifecycle.ts:231` contract tension, the read-write and scoped-write experiment results, and the `clone --shared` cost measurement), is now recorded in FG-345.

Create an implementable child ONLY if FG-345 chooses the writable-git option.
