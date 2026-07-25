---
id: FG-575
type: story
status: active
title: "FG-569 release.integration.test.ts: commits 'source snapshot' into the real checkout AND asserts an un-canonicalized /var path (macOS-host-red, Linux-CI-green)"
created: 2026-07-16
---

## Two distinct defects in one file

`src/v2/release.integration.test.ts` (FG-569's release-build coverage) has two independent problems. Both are
macOS-host-red and Linux-CI-green, so CI never sees either.

### 1. It COMMITS into the real checkout — and rewrites history

The test builds a release from the source tree and, in doing so, creates commits in whatever repository it runs
in. Observed live twice on 2026-07-24 while running `npm run test:integration` in the working checkout:

- First run: created `e22436e "source snapshot"`, author `t <t@t>`, on the active feature branch — 14 files,
  including an operator's unrelated in-progress edit to `seeds/model-policy.example.yml`.
- Second run: **replaced** that commit with `54d1b6a "source snapshot"` (16 files). The first commit was no longer
  in history — so the test does not merely add a commit, it REWRITES the branch.

Nothing was ultimately lost, but only because the work happened to be re-snapshotted and the operator's edit had
been backed up out-of-tree first. A test that rewrites the history of the repo it runs in can silently destroy
uncommitted or unpushed work, and it does so under a commit message and author that look like debris rather than
like the test's doing.

Consequence in practice: the root integration tier became unsafe to run in the working checkout at all. Every
heavy-tier run during that session had to be diverted to a disposable worktree or clone, and two OTHER tests
(`launch-cli.integration`, `launch-r2.integration`) cannot run alongside uncommitted changes because
`forge release` refuses a dirty source tree.

### 2. It asserts un-canonicalized `/var` paths

Two assertions compare an expected `/var/folders/...` path against an actual `/private/var/folders/...`:

```
✖ FG-569 build: the manifest pins the building interpreter, its ABI, the commit, and a lockfile identity
    + actual   '/private/var/folders/.../interpreters/node-.../bin/node'
    - expected '/var/folders/.../interpreters/node-.../bin/node'
✖ FG-569 entry (EXECUTED under /bin/sh): the $here derivation resolves a leading-dash release dir without `cd --`
```

macOS resolves `/var` through a symlink to `/private/var`; Linux has no such symlink, so the two spellings are
identical there and CI stays green. Same class as FG-556 and the dashboard `checkoutDir` assertions.

## Scope

- **Make the test build its release from an isolated copy** (a temp clone or worktree it creates and removes),
  never from the repository it is invoked in, and never committing into it. The FG-614 pass established the working
  pattern: verify in a throwaway clone, delete it, touch no git history in the checkout.
- **Canonicalize both sides** of the path assertions (`realpathSync` the expected value, or compare canonicalized
  forms), so they hold on macOS and Linux alike.
- Sweep the rest of the file for other real-checkout writes or un-canonicalized path comparisons rather than
  fixing only the two that fail today.

## Acceptance Criteria

- `node --test src/v2/release.integration.test.ts` passes on the macOS host from a clean checkout.
- Running it leaves the working checkout's git state **completely unchanged**: same HEAD, same branch, no new or
  rewritten commits, no stash entries, and no modified/untracked files. Assert this in the test itself, so a
  regression fails loudly instead of being discovered by an operator whose branch moved.
- Still passes in Linux CI (`test-extended`).
- `npm run test:integration` becomes safe to run in the working checkout — which is the operational point of this
  ticket, not just a green test.

## Relations

Same host-red class as FG-556 and FG-613 (FG-613 turned out to be shared-tmux-server contention and was fixed by
FG-614). The `/private/var` canonicalization half is the same defect shape as the FG-556 worktree assertion.
