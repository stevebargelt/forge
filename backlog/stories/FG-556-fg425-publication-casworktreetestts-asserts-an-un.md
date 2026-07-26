---
id: FG-556
type: story
status: active
title: fg425-publication-cas.worktree.test.ts asserts an un-canonicalized /var target path — fails on macOS hosts only (/var is a symlink to /private/var); green in Linux CI
created: 2026-07-14
---

---

## Same defect, more files (2026-07-25)

FG-559 shipped two new worktree-tier files that carry the identical un-canonicalized `/var` assumption:

- `src/v2/fg559-worktree-git-enforcement.worktree.test.ts`
- `src/v2/fg559-worktree-git-mount.worktree.test.ts`

Both build fixtures with `mkdtempSync(join(tmpdir(), ...))` and never `realpathSync` the result, so on
macOS the fixture path is `/var/folders/...` while git records `/private/var/folders/...`. Observed:
16 failures in the worktree tier on the macOS host, including `FG-425: the gate runs against the
CANDIDATE worktree` (this ticket's original case) and every `fg559e` test, with assertions of the shape:

```
fixture's gitdir: pointer must be an ABSOLUTE path into the parent's admin dir,
got /private/var/folders/.../fg559e-kyiDt2/host/parent/.git/worktrees/wt
```

Green in Linux CI, same as this ticket's original case — CI's `worktree` job passed the same tier at
the same commit. Net effect: an operator on macOS cannot run the worktree tier locally at all.

The fix pattern is already established: FG-575 `realpathSync`'d its workspace root for exactly this
reason. Whatever this ticket does for `fg425-publication-cas.worktree.test.ts` should be applied to
these two files in the same pass.

---

## Correction (2026-07-25): the FG-559 files are FIXED — this ticket is back to its original single file

The section above added `fg559-worktree-git-enforcement.worktree.test.ts` and
`fg559-worktree-git-mount.worktree.test.ts` to this ticket's scope. That was the wrong call: they were
brand-new files in an unmerged branch, fixable in place, and deferring them would have shipped tests
that cannot run on the operator's own platform. A review round flagged exactly that, and both were
canonicalized with `realpathSync` in `4c6e5d0` before FG-559 merged.

Worktree tier on the macOS host after that fix: **243 tests, 242 pass, 1 fail** — and the one failure is
this ticket's original case, `fg425-publication-cas.worktree.test.ts`.

So the scope here is unchanged from how it was filed: `fg425-publication-cas.worktree.test.ts` only. The
fix pattern is now demonstrated twice in-repo (FG-575's workspace root, and the two FG-559 fixtures):
`realpathSync(mkdtempSync(...))` at the fixture root.
