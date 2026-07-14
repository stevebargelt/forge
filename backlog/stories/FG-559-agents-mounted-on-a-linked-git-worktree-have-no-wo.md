---
id: FG-559
type: story
status: active
title: "agents mounted on a linked git worktree have NO working git — .git is a gitdir: pointer file into the parent repo, which is outside the container mount"
created: 2026-07-14
---

## Problem

A linked git worktree's `.git` is a **file**, not a directory. It contains a single line:

```
gitdir: /Users/stevebargelt/code/forge/.git/worktrees/<worktree-name>
```

`forge invoke --project <worktree>` bind-mounts only the worktree directory at `/project`. The
`gitdir:` target lives under the **parent repo's** `.git/`, which is **not** mounted. So inside the
container the pointer dangles and **every git command fails**:

```
fatal: not a git repository:
/Users/stevebargelt/code/forge/.git/worktrees/forge-durable-continuation-audit
```

No `git log`, no `git diff`, no `git blame`, no `git show` — the agent has the file tree and nothing
else.

## How it surfaced (2026-07-14)

A `red-wide` closure review of the FG-552 PRD was asked to verify "no files changed beyond the PRD"
and "the five BD edits were status-label-only" by diffing two committed SHAs. It could not run git at
all, and correctly returned `inconclusive` — refusing to certify two of its four checks rather than
substituting a visual read of the working tree for the diff it was told to run. Re-running the same
review against a standalone clone (real `.git` directory, both SHAs present) returned PASS on all four
checks with the diff actually executed.

The failure was only caught because that brief made a diff **mandatory**. Which is the real worry:

## Why this matters more than it looks

**Today it degrades silently.** An agent that would have consulted history just... doesn't, works from
the file tree, and reports success. Nothing errors at the forge level. There is no signal.

**The blast radius is about to grow:**
- **FG-345** — git worktrees for ALL agents — makes worktree mounts the default, not the exception.
- **FG-425** already creates per-attempt publication worktrees.
- **`forge review-loop`** reviewer/fixer agents are precisely the population that needs `git diff` to
  do their job at all. A reviewer that cannot see the diff it is reviewing is not a reviewer.

Shipping broad worktree adoption without fixing this leaves every history-dependent agent blind while
appearing to work.

## Possible directions (not yet decided)

1. **Also bind-mount the `gitdir:` target** (`<parent>/.git/worktrees/<name>`) plus whatever of the
   parent `.git` object store the worktree needs. Note the worktree's objects/refs live in the PARENT
   `.git`, so a partial mount may not be enough — needs verification, and read-only mounting of a
   parent `.git` into a red's container has its own trust questions.
2. **Rewrite `.git` inside the container** to point at a mounted location.
3. **Give the agent a standalone clone** instead of a linked worktree when it needs history (what the
   FG-552 closure check did as a one-off workaround — it is scaffolding, not a fix).
4. **Fail loudly**: detect a dangling `gitdir:` at container start and refuse/warn, so the degradation
   is never silent. This is the cheapest half-measure and is arguably required regardless of which of
   1–3 is chosen.

## Acceptance criteria

- An agent invoked with `--project <linked-worktree>` can run `git log`, `git diff <sha>..<sha>`, and
  `git show` against the project's real history.
- A `red-wide` review-loop reviewer mounted on a worktree can diff the range it is reviewing.
- A regression test covers the linked-worktree case specifically (a plain-clone mount would pass
  vacuously and prove nothing — the test must use a real linked worktree).
- Silent degradation is impossible: if git is unavailable in the mount, forge says so rather than
  letting the agent proceed history-blind.
