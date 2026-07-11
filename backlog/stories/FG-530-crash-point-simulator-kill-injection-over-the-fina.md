---
id: FG-530
type: story
status: active
title: "crash-point simulator: kill-injection over the finalize path, reconcile to fixpoint, assert lifecycle invariants"
created: 2026-07-11
---

## Problem

Forge's crash-safety story is proven piecemeal: each historical wedge/regression (the blocked_by_red two-write dance, unfinalized pipeline steps, orphaned fanout waves, gate-decision races) got its own targeted fix + regression test after it happened live. There is no systematic harness that CRASHES the runner at every write boundary and proves the lifecycle invariants hold through recovery — so new finalize-path writes ship with untested crash windows by default.

Strategic review §3.2. v1 scope is deliberately tight.

## v1 scope

Kill-injection harness over the runner's write sequences:

- **Kill points**: enumerate the write boundaries across (a) dispatchSingleStep's post-container sequence (result ingestion → validation-contract hold → verdict writes → finalizePrimary → event log), (b) gate.ts's decision writes (advance/reject/request-changes including on_reject recovery minting), (c) reconcile's own writes. Injection mechanism: a test-only hook in the store layer or event-boundary injection — whichever is cleaner; zero production behavior when the hook is unset.
- **Per kill point**: kill (throw/abort) at the boundary, then in a FRESH pass over a fake docker layer run reconcileRun + runNext to FIXPOINT (repeat until no state change).
- **Assert after recovery, per kill point**:
  1. No `complete` without its evidence chain (result present; verdicts for red-gated steps; validation contract satisfied or waived).
  2. No permanent wedge: every non-terminal state has an enabled transition or a NAMED operator verb (retry / gate / recover / reconcile suggestion).
  3. `abandoned` is never overwritten by completion.
  4. Persisted work is never discarded (a result/worktree that existed before the kill survives recovery).
  5. Fixpoint is reached and idempotent (a second reconcile+runNext pass is a no-op).

## Meta-AC (proves the harness works)

Seed one historical regression shape — the old blocked_by_red two-write dance (verdict write and status write as separate non-atomic writes, pre-FG-427/FG-482) — in a fixture and show the harness FLAGS it (the invariant assertions fail on the seeded shape).

## Acceptance Criteria

- Kill-point enumeration covers the three write surfaces above; each kill point is exercised by the matrix.
- The five invariant assertions run per kill point; all pass on current HEAD.
- Meta-AC fixture demonstrably fails the harness (test asserts the failure is detected).
- Wired into test:extended (the integration+ tier CI job), not the fast gate.
- Zero production-code behavior changes: any test-only hook must be inert without the env/flag; a content guard or equivalent proves the hook is never active outside tests.
- If a kill point exposes a REAL new bug on HEAD: FILE it, don't fix it in this ticket (scope guard).

## Notes

Filed 2026-07-11 as Item 5 (stretch) of the operator-directed reliability queue. Relates to FG-477 (the invariants are the evaluator's semantics), FG-427/FG-482 (the historical two-write dance), FG-479 (orphaned_needs_finalize).


## Status (2026-07-11, post-operator-review — coverage COMPLETE, awaiting final loop pass + merge)

The operator ruled: build the coverage, do not narrow. Shipped on PR #103 since then: zero-gap write-surface guard (DEFERRED_GAPS = 0 — every state-write in runNext/gate/reconcile probed or argued non-window with machine-checked reasons); mid-provisioning + container-gone-variant + fanout awaiting_red/blocked_by_red reconcile/dispatch windows all probed with reachable fixtures; the reconcile crash model fixed (CrashInjected can no longer be swallowed by never-throw guards); lossless SELECT-* fixpoint snapshots (invariant 5 names the moved column); kill-vs-smoke cell semantics named per cell with whole-registry kill guarantees; a worktree-tier lane (shared fg530-harness.ts) asserting real-worktree survival at 14 worktree-touching kill points, with invariant 4 strengthened to file-level snapshots; FOUR known-failure pins = the filed bugs FG-531 (single-step + fanout-parent variants), FG-532, FG-533. Concrete worktree-leak evidence recorded in FG-356.

