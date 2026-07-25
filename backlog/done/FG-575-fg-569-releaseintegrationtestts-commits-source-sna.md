---
id: FG-575
type: story
status: done
title: "FG-569 release.integration.test.ts: commits 'source snapshot' into the real checkout AND asserts an un-canonicalized /var path (macOS-host-red, Linux-CI-green)"
created: 2026-07-16
closed: 2026-07-25
closed_commit: 9a73105
---

## Two distinct defects in one file

`src/v2/release.integration.test.ts` (FG-569's release-build coverage) has two independent problems.
Both are macOS-host-red and Linux-CI-green, so CI never sees either.

### 1. It COMMITS into the real checkout

The test builds a release from the source tree and, in doing so, creates a commit in whatever
repository it runs in. Observed live on 2026-07-24 while running `npm run test:integration` in the
working checkout: it created a `"source snapshot"` commit, author `t <t@t>`, on the active feature
branch, sweeping up an operator's unrelated in-progress edit to `seeds/model-policy.example.yml`.

Reproduced first-hand 2026-07-25 in a disposable clone: with one uncommitted edit present, HEAD moved
`5f625f2` -> `3a9eb49 "source snapshot"` and the edit was swallowed into that commit.

A test that commits in the repo it runs in can silently capture uncommitted work, and it does so
under a commit message and author that look like debris rather than like the test's doing.

Consequence in practice: the root integration tier became unsafe to run in the working checkout at
all.

**Correction (2026-07-25):** the original filing also claimed the test REWRITES the branch, based on
a second run appearing to replace the first `"source snapshot"` commit. This could not be
substantiated. There is no `git commit --amend`, `git reset`, or force operation anywhere in the
file, so nothing in this code explains a history rewrite; the observed branch movement between the
two runs had another cause. The provable defect is the unwanted commit. The AC 2 assertion below
covers a rewrite regardless, since it compares HEAD for equality.

**Two findings that narrowed the fix:**

- **Line 76 was the ONLY offending call site.** `commitSource` had 17 callers; the other 16 pass
  `src`, a synthetic fixture inside the disposable temp workspace. Verified by call-site audit: every
  other argument traces to `mkdtempSync(join(workspace, ...))`.
- **The defect only fires on a DIRTY tree.** `commitSource` staged, then committed only if something
  staged differed — so on a clean checkout it was a no-op. A baseline run in a clean clone left HEAD
  and the tree untouched. This is why a git-state assertion exercised only against a clean tree
  passes VACUOUSLY even with the bug fully present.

### 2. It asserts un-canonicalized `/var` paths

Two assertions compared an expected `/var/folders/...` path against an actual
`/private/var/folders/...` (lines 115 and 247 pre-fix). macOS resolves `/var` through a symlink to
`/private/var`; Linux has no such symlink, so the two spellings are identical there and CI stayed
green. Same class as FG-556.

## Root cause of defect 1: an invariant asserted only in a comment

The file's header claimed it "Runs in the forge-test scratch (/tmp/forge-work)". Nothing enforced
this. `npm run test:integration` runs `scripts/run-integration-tests.sh`, which `find`s the
`*.integration.test.ts` files and `exec`s `node --test` **in place**, with no scratch sync — and the
file derived its target from the ambient cwd (`findGitRoot(process.cwd())`). The "disposable scratch"
the code was written against was an assumption stated in prose and true only when the operator
happened to invoke via `forge-test`.

## Acceptance Criteria

- `node --test src/v2/release.integration.test.ts` passes on the macOS host from a clean checkout.
- Running it leaves the working checkout's git state **completely unchanged**: same HEAD, same
  branch, no new or rewritten commits, no stash entries, and no modified/untracked files. Assert this
  in the test itself, so a regression fails loudly instead of being discovered by an operator whose
  branch moved.
- Still passes in Linux CI (`test-extended`).
- `npm run test:integration` becomes safe to run in the working checkout — which is the operational
  point of this ticket, not just a green test.
- The header comment no longer asserts a scratch-execution invariant the harness does not enforce.

## Acceptance Evidence

Shipped in merge commit `9a73105` (PR #160), squashing `ae1c2b1` (engineer) and `c29264d`
(test-engineer).

| AC | Evidence | Verdict |
|----|----------|---------|
| `node --test src/v2/release.integration.test.ts` passes on the macOS host from a clean checkout | Launch `fg575-verify-afmpmx` in a clean disposable clone: 35/35. Final host run `fg575-final-ve72fa` at `c29264d`: 36/36. Baseline before the fix, same clone: 30 pass / 2 fail — both the `/var` assertions. | met |
| Checkout git state completely unchanged, asserted in the test itself | `test("FG-575: the whole suite left the INVOKING repository's git state completely unchanged")`, declared last in the file, compares `head` / `branch` / `stash` / full `git status --porcelain` against a snapshot taken in `before()`. Discrimination proven by test-engineer mutation M3: reinstating the pre-fix `git add` + `commit` against the invoking root on a dirty tree turned it RED, naming the moved HEAD and the vanished ` M seeds/model-policy.example.yml`. | met |
| Still passes in Linux CI (`test-extended`) | Both required checks green at head `465c07f`: `test` SUCCESS and `test-extended` SUCCESS (aggregate over `integration_1..4`, `worktree`, `dashboard_integration` — all SUCCESS). | met |
| `npm run test:integration` becomes safe to run in the working checkout | Ran the fixed file in the LIVE forge checkout with a dirty tree (six uncommitted files under `docs/research/competitive/`): 36/36 pass, and afterwards HEAD, branch, stash list and all six files were byte-identical. This is the exact condition that previously destroyed work. | met |
| Header no longer asserts an unenforced scratch invariant | `src/v2/release.integration.test.ts:9-19` — the scratch claim is replaced with what is actually true and enforced ("It runs wherever it is invoked from ... and it NEVER writes to that repository"), plus the dirty-BUILDER precondition, which `assertBuilderCheckoutIsCommitted()` enforces in `before()`. | met |

### Note on where the coverage actually lives (test-engineer mutation M3b)

With the original defect fully reinstated but the invoking tree **clean**, the last-in-file assertion
PASSES. A clean tree is every CI run and every committed checkout. The assertion is therefore not the
thing that catches this bug in CI — the `FG-575: a DIRTY invoking checkout is NEVER committed into`
test is, because it drives the same prepare-then-build path against a deliberately dirtied stand-in.

The two are complementary, not redundant. Anyone later "simplifying" this suite by deleting the
stand-in test as duplicative of the last one would remove the only CI-effective coverage of the
defect. Both must stay.

### Additional verification performed

- **Call-site audit:** all 16 remaining `commitSource(...)` sites verified to target disposable
  fixtures only, and the new runtime guard (refusing any root outside the workspace) is itself tested.
- **Vacuity repair:** the DIRTY stand-in test's premise guard was originally `status !== ""`, which
  held unconditionally because `isolatedSourceFrom` does not copy the root `.gitignore`, so every
  isolated copy carries an untracked `node_modules/`. Replaced with assertions that NAME the two
  in-progress paths (test-engineer mutation M2 / M2-prime).
- **No regression in identity separation:** mutation M4 confirmed the successor-build test still
  discriminates `builderCommit` from source `commit` under the new execute-the-isolated-copy's-CLI
  shape.

## Relations

Same host-red class as FG-556. Follow-ups: **FG-617** (the tier now requires a committed `src/`,
`package.json` and lockfile — refusal only, never a write; same precondition the sibling
`launch-*.integration` tests carry). **FG-618** closed as a false premise (spawns already inherit a
disposable `FORGE_HOME` from `test-setup.ts:6-7`). **FG-619** rejected (the git-state assertion is
correct as shipped; the false red that prompted it was a checkout mutated concurrently by the
orchestrator during the run, an invalid validation environment).
