
**Parent:** FG-553 · **Found during:** FG-571 (Child 4) host verification. **Pre-existing on `origin/main` @ `48ce1c6`** — proven in a disposable worktree at true origin/main with zero FG-571 code: identical `28 pass / 1 fail`. NOT an FG-571 regression.

## Two independent defects, same file (`src/v2/release.integration.test.ts`)

### 1. It COMMITS INTO THE REAL CHECKOUT (destructive, dev-only)
`commitSource()` (`release.integration.test.ts:44`) runs `git add` + `git commit -q -m "source snapshot"` against `findGitRoot(process.cwd())` — the real checkout the tests run from. On a CLEAN checkout (CI) it is a no-op, so CI never sees it. On a DIRTY dev checkout it **stages and commits the developer's in-progress work under a junk message**.

Bit this session three times during FG-571 verification (`3f903ed`, `fd935ff`, `03d6a33` — each swallowing the uncommitted FG-571 work; each needed `git reset --soft HEAD~1` to recover). One of those (`03d6a33`) silently invalidated a provenance check, because a later "test at clean main" was actually testing a `source snapshot` commit that contained the very work under test.

Also **racy**: two suites doing this in `before()` under one `npm run test:integration` collide on `.git/index.lock` (`fatal: Unable to create ... index.lock`, status 128).

**Fix:** migrate to the disposable-source-root harness FG-571 built for exactly this — `src/v2/fg571-harness.ts` (mkdtemp + `git init` + copy the commit-bound paths + **symlink** `node_modules`, then commit inside the throwaway root). Never invoke git against the real source root.

### 2. It asserts an UN-CANONICALIZED `/var` path (FG-556 class, macOS-host-only)
```
✖ FG-569 entry (EXECUTED under /bin/sh): the $here derivation resolves a leading-dash release dir without `cd --`
  actual:   '/private/var/folders/.../-dashy-release'
  expected: '/var/folders/.../-dashy-release'
```
macOS `/var` is a symlink to `/private/var`, so the entry's `cd`+`pwd` correctly returns the canonical path while the fixture compares against the un-canonicalized one. **Green in Linux CI, red on every macOS host.** Identical class to **FG-556** (`fg425-publication-cas.worktree.test.ts`) — consider fixing both together, and consider a shared canonicalizing assertion helper so this class stops recurring.

**Fix:** canonicalize the expected path (`realpathSync`) before comparing.

## Why not fixed in FG-571
Both are pre-existing defects in FG-569's test file, neither touches FG-571's promotion invariant, and both are host-ergonomics/CI-blind-spot issues rather than shipped-behavior bugs — the required CI checks are green on both counts. Fixing them inside FG-571 would expand its review range into an unrelated file. Filed instead, per the scope boundary.

## Acceptance
- `node --test src/v2/release.integration.test.ts` passes **on a macOS host**, and `git log --oneline -1` is unchanged afterwards on a **dirty** checkout.
- The suite is safe to run concurrently with the FG-571 suites in one `npm run test:integration`.
- A mutant that reintroduces the un-canonicalized comparison reddens on macOS.
