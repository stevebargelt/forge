---
id: FG-567
type: story
status: active
title: "FG-553 Child 0: bin/forge signal/exit fidelity — re-raise the child's actual signal, never launder a kill to exit 0 or exit 128"
created: 2026-07-14
---

**Parent:** FG-553 (Slice 1) · **Epic:** FG-561 · **Plan:** `docs/plans/fg553-slice1-architecture.md` @ `4d986ec` (Child 0)

**PREREQUISITE for every other FG-553 child.** A killed child that reads as success (or a signal laundered to
a number) silently corrupts the executed acceptance evidence of every later child — a promotion/ABI/F35 test
that kills a process and trusts `forge`'s disposition would misread it. This lands first; the others stay
stopped until this is green.

## Problem (verified by execution)

`bin/forge:11` is `child.on("exit", (code) => process.exit(code ?? 0))`. A SIGKILL'd child gives `code=null`,
so **`forge` exits 0** — a killed control plane reports success. Anything trusting `forge`'s exit code (CI,
scripts, the review-loop's own verification) is misled. This violates BD-3 ("a dead owner is never guessed
into success") in the live artifact.

**`process.exit(128)` (cf. `claude.ts:241`) is NOT the fix.** It prevents the false `exit 0` but converts
OS-signal evidence into an ordinary numeric 128 — the same F7/F8 attribution loss. A direct observer must
still see the signal.

## The fix — SIGNAL FIDELITY

Re-raise the child's own signal on the wrapper; mirror the code otherwise:

```js
child.on("exit", (code, signal) => {
  if (signal) { process.kill(process.pid, signal); return; }  // re-raise → direct observer sees the signal
  process.exit(code ?? 0);
});
```

## Acceptance (EXECUTED; all three mutation-tested — plan Appendix A3, `docs/plans/fg553-probes/signal-fidelity.sh`)

A **direct process observer** of the wrapper must see:

- child exits **0** → wrapper `code=0, signal=null`.
- child **numerically** exits **143** → wrapper `code=143, signal=null` — **stays numeric, the F8 case; must
  NOT become a signal.**
- child killed by **SIGTERM** → wrapper `code=null, signal=SIGTERM` (re-raised).
- child killed by **SIGKILL** → wrapper `code=null, signal=SIGKILL`.

Layering kept explicit: a shell later encodes a signalled exit as `$?=128+signum` (143/137), but that number
is **not** itself OS-signal evidence (a program can deliberately `exit(143)`). The test asserts the **direct
observer's** `(code, signal)`, not the shell number.

**Red baseline exists today** (SIGKILL child → `forge` exits 0). **Mutants, each reddening a distinct case:**
restore `code ?? 0` → SIGKILL case reads success; use `process.exit(128)` → signalled case loses `signal`
(becomes numeric 128) and risks conflating the deliberate-143 case; treat numeric 143 as a signal → F8 case
reddens.

**Falsification is executable and committed:** `docs/plans/fg553-probes/signal-fidelity.sh` +
`signal-fidelity.out` (runtime: node v24.17.0, ABI 137, darwin arm64).

## Scope fence

- Touch **only** `bin/forge` (+ its test). Do not touch the launch impl, the store, the backlog, or the PRD.
- This is NOT the exec-not-spawn rework (that is Child 2); this is the minimal signal-fidelity fix to the
  existing spawn-based entry point, so later children's kill-based tests are trustworthy.
- Writer runs on a **standalone clone** (never writable `main` until FG-553's isolation lands); reviewers
  read-only. Fresh clones need `npm ci` before verification (FG-566).
