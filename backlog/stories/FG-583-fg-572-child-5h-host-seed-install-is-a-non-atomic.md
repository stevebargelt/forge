---
id: FG-583
type: story
status: active
title: "FG-572 Child 5h: host seed install is a non-atomic cp loop — an interrupted upgrade can expose a mixed but Zod-valid workflow set to a concurrent forge next"
created: 2026-07-17
---

**Parent:** FG-572 · **Epic:** FG-561 · **Depends on:** FG-577 (install from the correct tree first)
**Source:** bounded pre-implementation audit, run
`run-fg-577-fg-578-bounded-pre-implementation-audit-of-the-forge-install-provenance-surface-b19e9a`
(task-red-security-125943), read-only at `07f2c8d`. Findings 3 (medium) + 4 (medium). **NEW scope discovered
by the audit — not part of FG-577's or FG-578's acceptance criteria.**

## Defect

Host seed installation is a **sequential `cp` loop with no staging, no publication point, no lock, and no
rollback** (`scripts/install-seeds.sh:24-30`, driven by `src/cli/commands/upgrade.ts:140`). `forge next`
consumes the shared workflow surface directly, with no provenance/readiness check
(`src/cli/commands/next.ts:39` → `src/v2/loader.ts:44-66`).

Two supported Forge processes therefore share `$FORGE_HOME` with no protocol:

- Process A runs `forge upgrade` and is interrupted, or is simply between `cp` calls.
- Process B runs `forge next` and reads a **truncated YAML** (fails dispatch), or — the sharp case — reads an
  **old/new mixture that still passes Zod** and dispatches under a workflow/policy set **no release ever
  shipped**.

`doctor` cannot even name the mixed state, because `SEED_SPECS` (`src/v2/seed-drift.ts:46-51`) omits
workflows entirely (that omission is FG-579's).

The PRD's settled threat boundary explicitly protects **crashes / interrupted writes** and **concurrent
supported Forge processes**. This violates that boundary with **no attacker and no same-UID tampering** — an
ordinary interrupted upgrade is sufficient. It is NOT the same-principal case FG-571 dispositioned as an
honest limit.

Related: an install that fails partway leaves a mixed host while `upgrade` reports completion and does not
block consumers (finding 4). The resulting state is detectable by `doctor`/`route validate` **when invoked**,
but not on the ordinary dispatch path.

## Scope

Either publish the complete consumed host surface **atomically** with a cross-process reader/writer protocol,
or make every **consuming dispatch** refuse on a detected incomplete/mixed surface. Prefer whichever is the
smaller mechanism — FG-571's lesson stands: elaborate safety machinery signals a wrong architecture, and the
invariant should MOVE rather than accrete guards. Note FG-571 already settled an atomic-publication pattern
(one-swap `(current, previous)`, staged unit, never a sibling record) — reuse that vocabulary; do not invent
a second.

A failed/interrupted installation must have a **named, repairable state**, propagated to human output,
`--json`, exit status, doctor, retry advice, and dispatch/campaign consumers.

## Acceptance (EXECUTED)

- Kill/read interleavings — after agents copied, mid-`workflows`, and before/failed recompile — must **never**
  permit `forge next` to dispatch a **mixed but Zod-valid** workflow set. Observed RED against current code:
  the mixed-valid dispatch must be reproducible before the fix.
- A reader interleaved between individual installed files never consumes a torn surface.
- An interrupted install leaves a named, repairable state — not a host that reports healthy.
- Propagation consumers asserted: library, CLI human output, `--json`, exit code, doctor, retry advice,
  campaign/dispatch.
- Tests use **disposable FORGE_HOME**; the real `~/.forge` is never touched.

## Not in scope
- The workflows coverage gap in `SEED_SPECS` and the ownership/severity split (FG-579).
- Source selection for the installer (FG-577).