---
id: FG-570
type: story
status: done
title: "FG-553 Child 3: bounded ABI assertion replacing the minimum-major floor"
created: 2026-07-14
closed: 2026-07-16
closed_commit: 5044c5d
---

**Parent:** FG-553 · **Epic:** FG-561 · **Plan:** `docs/plans/fg553-slice1-architecture.md` (Child 3)
**Depends on:** FG-569 (the release manifest carries the ABI to assert against).

## Problem

`src/cli/node-preflight.ts:26` is a **minimum-major** check: it returns ok for any Node major ≥ the floor. So
it admits Node 26 (ABI 147) on a host where the repo's `better-sqlite3` binding is ABI 137 — the guard fires
on a downgrade but WAVES UPGRADES THROUGH, and the operator then gets an opaque native `ERR_DLOPEN_FAILED`
instead of the guard's clear message. A version floor is not an ABI check.

## Scope

Replace the minimum-major floor with an **exact, bounded ABI assertion** against the ABI the native bindings
were actually built for (the release manifest's ABI once FG-569 lands; `process.versions.modules` vs the
binding's required `NODE_MODULE_VERSION`). Assert an **upper AND lower** bound — a too-NEW incompatible ABI
must be rejected, not admitted. The refusal must run **before any native module loads**, with a named,
actionable message (not an opaque dlopen crash).

## Acceptance (EXECUTED; execute-don't-grep)

- **F31 (too-new):** run the control plane under a real Node whose ABI the binding was NOT built for
  (v26.3.1/ABI 147 is on this host) → a **named refusal BEFORE native load**, not `ERR_DLOPEN_FAILED`, not a
  successful run. The pass condition IS a clean pre-load refusal.
- **too-old:** likewise rejected with the named message.
- **compatible (ABI match):** runs normally — no false refusal.
- **Red baseline exists today:** `node-preflight.ts:26` admits Node 26; the fix's test must be RED against the
  minimum-major floor (mutant: revert to `>=` → the too-new case reddens).

## Not in scope
- Promotion / release building (FG-569, FG-571). This slice only replaces the ABI gate.
