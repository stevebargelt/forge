---
id: FG-571
type: story
status: active
title: "FG-553 Child 4: atomic promote/rollback + PATH shim + env-sanitization contract (swap-and-retain, no GC)"
created: 2026-07-14
---

**Parent:** FG-553 · **Epic:** FG-561 · **Plan:** `docs/plans/fg553-slice1-architecture.md` (Child 4)
**Depends on:** FG-569 (release + manifest), FG-570 (ABI assertion).

## Problem

FG-569 builds an inert release; nothing promotes it to be the machine-wide `forge`. Promotion must be atomic
and reversible, must not break an in-flight process, and must not let the caller's ambient environment
subvert the pinned interpreter (proven: `NODE_OPTIONS=--import <evil>` injects before forge, and a bad
`NODE_OPTIONS` blocks startup, even with an absolute pinned interpreter).

## Scope

- **`current` pointer + atomic promote/rollback** — a release-dir + atomic `current` symlink swap; rollback
  is a pointer swap. An interrupted promotion leaves the previous stable runtime selected and usable.
- **The near-frozen `/bin/sh` PATH shim** (the machine-wide `forge`): resolve `current` → read manifest →
  `exec` the manifest interpreter. Installed atomically (temp + rename); its contract change is an
  install-level breaking change, gated behind an explicit re-install.
- **External-artifact contract:** the interpreter store is immutable/versioned, validated before a release
  references it, retained while referenced, never replaced in place.
- **Env-sanitization contract:** the launcher neutralizes caller Node/runtime-injection vars
  (`NODE_OPTIONS`, `NODE_PATH`, and peers) so ambient env cannot redirect or block the pinned interpreter.
- **Swap-and-RETAIN; NO automatic GC.** T9 (host-verified): a process anchors to a release at start and a
  pointer swap does not tear it, but **deleting a release with anchored live processes is fatal** (ESM,
  CJS, and native dlopen all uniform). So a release is never GC'd while anchored; automatic GC waits for a
  proven anchored-process lifetime mechanism in a later ticket.
- **`forge-dev` / `npm run forge`** live-source path preserved.

## Acceptance (EXECUTED)

- **F26:** validated promotion → new commands atomically use the promoted version; no mixed tree visible.
- **F27:** interrupted promotion → previous stable runtime stays selected; also covers an interrupted
  interpreter-install and an interrupted shim-install.
- **F28 / T9:** a process anchored to a release is unaffected by a mid-flight swap (test a lazy NATIVE binding
  load AND a lazy CJS require); a release is never deleted while anchored.
- **F29 (env):** bare `forge` from a shell the operator did NOT pre-sanitize runs — including a node-free
  PATH; `NODE_OPTIONS=--import <evil>` does NOT inject (proven red today); a blocking `NODE_OPTIONS` does not
  prevent startup. A caller-applied PATH pin is containment, not isolation — it does not satisfy F29.
- **F25:** `forge-dev` against broken source fails LOCALLY; stable `forge` still succeeds.

## Not in scope
- Automatic release GC (deferred — needs a proven anchored-process lifetime mechanism).
- Installed-surface (seeds/hooks/dashboard) compatibility — FG-572.
