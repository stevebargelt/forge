---
id: FG-556
type: story
status: done
title: fg425-publication-cas.worktree.test.ts asserts an un-canonicalized /var target path — fails on macOS hosts only (/var is a symlink to /private/var); green in Linux CI
created: 2026-07-14
closed: 2026-07-29
closed_commit: 9623a704
---

---

## Current disposition (2026-07-28)

This is an open, actionable test defect. It is **not** an accepted macOS baseline
and `434/435 with FG-556 red` must not be described as the expected successful
outcome. Forge's orchestrator runs on macOS; a permanently red host tier makes
real regressions harder to distinguish from standing noise. The close condition
for the current tier is **435/435**, with no known-failure exception.

The mechanism is established:

- `makeProject()` in `src/v2/fg425-publication-cas.worktree.test.ts` creates its
  fixture with `mkdtempSync(join(tmpdir(), "fg425-cas-"))`. On macOS that spelling
  is under `/var/folders/...`.
- Forge correctly passes the project through `projectIdentity()`, whose
  `realpathSync()` records the physical path under `/private/var/folders/...`.
- The test later expects the durable target to equal ``local:${dir}#main`` using
  the original, uncanonicalized fixture spelling. The product value is correct;
  the assertion's fixture identity is wrong.
- Linux CI is green because Linux does not have macOS's `/var` →
  `/private/var` alias. That does not validate the macOS assertion.

This is neither a product change nor an extreme edge case: `tmpdir()` is the
ordinary fixture path on the supported host. The established repair is to
canonicalize the fixture root once, at creation:
`realpathSync(mkdtempSync(...))`. FG-575 and the corrected FG-559 tests already
use this pattern.

### Scope

- Fix `src/v2/fg425-publication-cas.worktree.test.ts` only.
- Do not weaken or remove production canonicalization in `projectIdentity()`.
- Do not skip the test on macOS and do not encode `434/435` as an allowed result.

### Acceptance criteria

- The targeted FG-425 publication test passes on macOS while still asserting the
  canonical durable target.
- The complete worktree tier is green on macOS (**435/435 at the current test
  count**) with no FG-556 exception.
- Required Linux CI remains green.
- The diff is limited to the test fixture/assertion support needed for path
  canonicalization; no production behavior changes.

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

## Acceptance Evidence

Shipped in `9623a704` (PR #176). The assertion at fg425-publication-cas.worktree.test.ts:117 canonicalizes both sides (realpath), preserving the test's intent (the exact validated commit lands from the candidate worktree — bounded-review Q4 verified). Executed evidence ON THE CLAIMING LANE: macOS host worktree tier @ 9623a704 — 435 pass / 0 fail / 0 skipped, this test executing and passing (it was the tier's sole unconditional red before). Linux CI green throughout (was never affected).

| AC | Evidence | Verdict |
|----|----------|---------|
| Test passes on macOS hosts (the /var→/private/var symlink) without weakening the publication-CAS assertion | Canonicalized comparison; host worktree tier @ 9623a704: 435/0/0 with the test executed; bounded review confirmed intent preserved | met |
