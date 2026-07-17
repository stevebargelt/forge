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

## Closure evidence — 5044c5d

*Recorded 2026-07-16. The Problem, Scope, and Acceptance sections above are the original contract
as written and are deliberately left unedited; the environmental correction below is confined to
this section.*

Merged as `5044c5d` (squash of PR #123). Reviewed tip `ef35877`.

### AC → evidence

- **F31 (too-new) — met.** Mandatory CI execution under a real **Node v26.3.1 / ABI 147** at the
  exact PR head `ef35877` (`test-extended`): named refusal **before native load**, no
  `ERR_DLOPEN_FAILED`, and **no skip** — the arm reddens rather than skipping when the mismatched
  interpreter is absent, so the gate cannot silently pass. CI provisioned the interpreter and
  asserted its ABI differs from the active one before running the arm.
- **Additional host too-new evidence.** **Node v25 / ABI 141** produced the named refusal
  (exit 1, no `ERR_DLOPEN_FAILED`).
- **too-old — met.** Host **Node v23 / ABI 131** produced the named refusal.
- **compatible — met.** Host **Node v24 / ABI 137** ran without false refusal, including the
  **numeric-manifest-ABI** case (an unquoted `"abi": 137` is coerced and runs rather than
  crashing on its own manifest's type).
- **Red baseline / mutation — met.** Restoring the old `>=` comparison admits the too-new ABI and
  makes the regression test fail, so the test is genuinely RED against the minimum-major floor
  rather than merely green against the fix.

### Supporting properties

- The preflight remains the **first CLI import**, and its **import graph is proven native-free**
  by an executed probe — the refusal cannot lose the race to `better-sqlite3`.
- **Both required CI checks** (`test`, `test-extended`) were **green at `ef35877`**.
- **Final review outcome: `closeout_guidance_only`** — the reviewed tip **equaled the fetched
  remote head** and **no substantive finding** remained (the only residual guidance was backlog
  closeout, performed post-merge).

### Correction to the original environmental assumption

The Acceptance section above states that **v26.3.1 / ABI 147 is on this host**. **It was not.**
No Node 26 was installed on the host (nvm topped out at **v25 / ABI 141**), so the too-new arm
could not be executed locally as the ticket assumed. Instead:

- **CI provisions v26.3.1 / ABI 147** and runs the F31 arm there, mandatorily.
- The **host's too-new arm used Node v25 / ABI 141**.

This **changes no acceptance semantics**: both v26.3.1/ABI 147 and v25/ABI 141 are genuinely
incompatible **newer** ABIs relative to the binding's ABI 137, which is exactly the condition F31
exists to prove — a too-new interpreter must be refused by name rather than waved through to an
opaque native failure. The AC's intent is met; only the assumed location of the interpreter was
wrong.
