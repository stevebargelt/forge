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

1. **Release-closure builder** (`forge release build` / `src/v2/release.ts`): an immutable release dir =
   entry + source + the **entire `node_modules`** (nested symlinks dereferenced to real bytes — an npm-linked
   dep must not escape the closure) + the compiled `better_sqlite3.node` + `forge-release.json` (commit SHA,
   **absolute interpreter path**, ABI, node version, lockfile identity). A **torn closure** — missing/corrupt/
   ABI-mismatched binding, missing tsx loader, **or a node_modules that does not match its lockfile** — is
   **REFUSED at build**.
2. **exec-not-spawn** (`bin/forge` + `bin/forge-loader.mjs`): `#!/bin/sh` that resolves `$0` **through
   symlinks** (the machine-wide `forge` is installed by npm-link as a symlink), then `exec`s node ONCE with
   tsx loaded in-process. Exactly one process; its `process.execPath` **is** the control runtime.
3. **R1** (`forge release provenance`): the running process's execPath/ABI, compared to the manifest.
4. **R2** (`src/v2/launch.ts` exit recorder): the recorder captures its **own** execPath/ABI/release-id from
   INSIDE the recorder — never copied from R1. The **built release entry exports `FORGE_RELEASE_ID`** from its
   manifest so a real release's launches carry a non-null release id; dev-mode `bin/forge` (no manifest)
   leaves it null.

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
- **Closure binding:** a mutant that leaves `package-lock.json` unchanged but mutates/substitutes an INSTALLED
  dependency that still loads is **REFUSED at build** (red against the lockfile-bytes-only builder, green after
  a real lockfile-to-shipped-closure binding). tsx + better-sqlite3 load-checks are additional, not the binding.
- **Tests are correctly tiered:** subprocess/spawn/npm-invoking tests live in `*.integration.test.ts`, never a
  unit `*.test.ts` (tier-purity guard, FG-406/408). `npm run test:all` and the extended tier are green.

## Not in scope
- Promotion, `current` symlink, rollback, the PATH shim, env-sanitization — FG-571 (Child 4).
- R3/R4 (launched-workload provenance) — FG-555.
