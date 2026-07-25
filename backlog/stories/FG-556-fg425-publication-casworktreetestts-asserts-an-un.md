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
