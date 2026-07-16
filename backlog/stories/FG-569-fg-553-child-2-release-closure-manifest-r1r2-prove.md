---
id: FG-569
type: story
status: active
title: "FG-553 Child 2: release closure + manifest + R1/R2 provenance (inert, exec-not-spawn, no promotion yet)"
created: 2026-07-14
---

**Parent:** FG-553 · **Epic:** FG-561 · **Plan:** `docs/plans/fg553-slice1-architecture.md` (Child 2)

## Problem

The stable control runtime (FG-553/BD-14) needs a self-contained, immutable **release** and a launch entry
that runs a **pinned** interpreter — the prerequisite for FG-571's atomic promotion. Two structural defects
in the current entry block this:

- `bin/forge` was `#!/usr/bin/env node` and **spawned** `node_modules/.bin/tsx` (itself `#!/usr/bin/env node`),
  so the process that actually loaded `better-sqlite3` was a PATH-resolved **grandchild** — not the process
  forge started. That makes R1 name the wrong runtime and leaves forge broken under a node-free PATH (F29).
- There is no release artifact: nothing captures the interpreter/ABI/dependency-closure identity a promotion
  would pin.

**INERT slice:** builds the release and lands exec-not-spawn; it does NOT promote, write `current`, or change
the machine-wide PATH — that is FG-571 (Child 4).

## Scope

1. **Release-closure builder** (`forge release build` / `src/v2/release.ts`): an **immutable, read-only-at-rest**
   release dir = entry + source + the **entire `node_modules`** (nested symlinks dereferenced to real bytes —
   an npm-linked dep must not escape the closure) + the compiled `better_sqlite3.node` + `forge-release.json`
   (commit SHA, **absolute interpreter path**, ABI, node version, lockfile identity). The tree is frozen
   (write bits cleared on files AND directories, traversal + executables preserved) in staging BEFORE the
   atomic rename. A **torn closure** — missing/corrupt/ABI-mismatched binding, missing tsx loader, **or a
   node_modules that does not match its lockfile** — is **REFUSED at build**.
2. **exec-not-spawn** (`bin/forge` + `bin/forge-loader.mjs`): `#!/bin/sh` that resolves `$0` **through
   symlinks** (the machine-wide `forge` is installed by npm-link as a symlink), then `exec`s node ONCE with
   tsx loaded in-process. Exactly one process; its `process.execPath` **is** the control runtime.
3. **R1** (`forge release provenance`): the running process's execPath/ABI, compared to the manifest.
4. **R2** (`src/v2/launch.ts` exit recorder): the recorder captures its **own** execPath/ABI/release-id from
   INSIDE the recorder — never copied from R1. The **built release entry exports `FORGE_RELEASE_ID`** from its
   manifest so a real release's launches carry a non-null release id; dev-mode `bin/forge` (no manifest)
   leaves it null.
5. **Honest provenance binding** (`src/v2/release.ts`): the lockfile binding covers **install-script packages**
   (better-sqlite3, esbuild, sharp) — their tarball-owned files are byte-bound; only genuinely generated
   artifacts (the compiled `.node`, downloaded platform binaries) are unbound, via narrow explicit allowances,
   never a package-level skip. The **manifest commit is bound to the copied source**: the builder refuses a
   dirty relevant source (`src/`, `package.json`, the selected lockfile) — or records an independently
   verifiable source identity — so `commit` never describes bytes it did not produce, and the builder checkout
   (which generates the entry/loader) is not conflated with a different `--source` checkout.

## Acceptance (EXECUTED; execute-don't-grep)

- **exec-not-spawn:** `bin/forge` runs real commands (`--version`, `status --json` loading better-sqlite3) in
  ONE process, 0 children.
- **Symlink survival:** `forge` invoked THROUGH a PATH symlink (the npm-link install) runs — both `bin/forge`
  and a built release entry.
- **R1:** the built release entry runs under a **node-free PATH** and reports execPath == manifest interpreter,
  ABI == manifest ABI.
- **R2 independence:** two recorders under two interpreters record two DIFFERENT execPaths (a copy-from-R1
  recorder cannot); a launch THROUGH a built release records the real `releaseId` (not injected).
- **Signal fidelity preserved under exec:** a SIGKILL/SIGTERM'd forge reports the signal to a direct observer
  (never laundered to exit 0); a numeric exit is preserved. (The FG-567 guard is rewritten for the exec form
  and stays mutation-sensitive.)
- **Immutable at rest:** a built release is read-only — a direct file write, an `rm`+recreate via a parent dir,
  and a new-file injection into a release dir all FAIL; directories stay traversable, executables executable,
  and the frozen release still runs.
- **Closure binding — ALL lockfile-pinned packages, including install-script ones:** a mutant that leaves
  `package-lock.json` byte-identical but mutates/substitutes an INSTALLED dependency that still loads is
  **REFUSED at build**. This holds for install-script packages too: mutating a tarball-owned file of
  better-sqlite3 / esbuild (DB still opens / binary still runs) is REFUSED. Only genuinely generated artifacts
  are unbound (narrow per-file allowances, never a whole-package skip). An untampered build of the real tree
  still SUCCEEDS (no false refusal). tsx + better-sqlite3 load-checks are additional, not the binding.
- **Lockfile selection:** the one effective lockfile (npm-shrinkwrap.json > package-lock.json) is selected once
  and threaded through copy, binding, and manifest; package-lock-only, shrinkwrap-only, and both-present
  (shrinkwrap wins) all build correctly.
- **Source-commit binding:** a valid UNCOMMITTED change under `src/` does NOT ship under a manifest that claims
  the clean HEAD — the builder REFUSES the dirty source (or records a source identity that demonstrably differs
  from the clean HEAD). The builder's own identity for the generated entry/loader is recorded distinctly from
  the `--source` commit and equals it on a normal self-build.
- **Tests are correctly tiered:** subprocess/spawn/npm-invoking tests live in `*.integration.test.ts`, never a
  unit `*.test.ts` (tier-purity guard, FG-406/408). `npm run test:all` AND `npm run test:extended` are green.

## Not in scope
- Promotion, `current` symlink, rollback, the PATH shim, env-sanitization — FG-571 (Child 4).
- R3/R4 (launched-workload provenance) — FG-555.
- PRD current-state-map reconciliation — FG-573 (post-merge docs follow-up).

## Closure evidence (EXECUTED — merged as `1b11f25`, CI `test` + `test-extended` green at reviewed tip `4213ca6`)

Each acceptance line, with the test and the orchestrator's host execution against the real `forge`/release:

- **exec-not-spawn:** `bin/forge` is a `#!/bin/sh` shim that `exec`s node once with tsx in-process.
  `src/v2/bin-forge-signal-fidelity.integration.test.ts`; host: a built release entry ran `--version` (→ `0.1.0`)
  and `status --json` in ONE process.
- **Symlink survival:** host-verified — a promotion-style symlink to the release entry ran `--version` and
  `status --json` under a PATH containing NEITHER `node` NOR `readlink` ($0 canonicalized via the pinned
  absolute interpreter's `realpathSync`, no PATH lookup). `bin/forge` + the entry both run under strict POSIX
  `dash` (no `cd --`).
- **R1:** host — the release entry ran under a node-free PATH; `forge release provenance` reports
  execPath/ABI == manifest; R1 is ALSO durably captured per launch (`control:` in `forge launch show` human+JSON).
  `src/v2/launch-cli.integration.test.ts` R1 cases.
- **R2 independence:** `src/v2/launch-r2.integration.test.ts` (two recorders / two interpreters → different
  execPaths). Host: a release launch records its true manifest id; a poisoned `FORGE_RELEASE_ID` on a DEV launch
  records `null`, on a RELEASE launch records the true manifest id — releaseId derived from the manifest, never
  the ambient env.
- **Signal fidelity under exec:** `src/v2/bin-forge-signal-fidelity.integration.test.ts` (FG-567 guard rewritten
  for the exec form, mutation-sensitive); green in CI `test-extended`.
- **Immutable at rest:** host — a built release is `dr-xr-xr-x` dirs / `-r--r--r--` files / `-r-xr-xr-x` entry;
  direct write, `rm`+recreate via parent dir, new-file injection, and root-manifest tamper ALL refused; the frozen
  release still runs. `src/v2/release.integration.test.ts` immutability + dir-tamper cases.
- **Closure binding (ALL packages incl. install-script):** host — mutating `node_modules/better-sqlite3/lib/index.js`
  (DB still opens, `package-lock.json` byte-identical) is REFUSED; an untampered build succeeds; one narrow
  exact-path allowance (`node_modules/esbuild/bin/esbuild`), never a package-level skip.
  `src/v2/release.integration.test.ts` lockfile-binding + install-script cases.
- **Lockfile selection:** `src/v2/release.integration.test.ts` — package-lock-only, shrinkwrap-only, and
  both-present (shrinkwrap wins) all build and bind/manifest against the one selected lockfile.
- **Source-commit binding:** host — a dirty `src/`/`package.json`/lockfile/`seeds`/`scripts`/`docker` is REFUSED;
  `builderCommit` is recorded distinctly from the source `commit`; a RELEASE builds its SUCCESSOR (A→B, distinct
  commits) recording A's manifest commit as B's `builderCommit`, separate from B's source commit; the build-window
  TOCTOU is closed — commit-bound content is materialized from `git archive <commit>`, so a live-tree mutation
  MID-build does not leak (shipped bytes == committed bytes, executed via the `onBeforeSnapshot` seam).
  `src/v2/release.integration.test.ts` dirty-source + successor-build + TOCTOU cases.
- **Tests correctly tiered:** subprocess/spawn/git-archive tests live in `*.integration.test.ts`; tier-purity guard
  (FG-406/408) green. Both required CI checks — `test` (`npm run test:all`) and `test-extended`
  (`npm run test:extended`) — green at the reviewed tip.

Reviewed via the bounded review-loop to a clean code verdict (zero code findings; reviewed tip == remote head).
The only withheld review finding was the PRD current-state map (out of this ticket's range) — deferred to FG-573.
