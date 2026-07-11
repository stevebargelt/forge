---
id: FG-530
type: story
status: done
title: "crash-point simulator: kill-injection over the finalize path, reconcile to fixpoint, assert lifecycle invariants"
created: 2026-07-11
closed: 2026-07-11
closed_commit: fbbc1d5
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



## Close evidence (2026-07-11, PR #103, merge fbbc1d5)

AC walk:
- **Kill-point enumeration covers the three write surfaces; each exercised**: 60+ registered kill points across dispatchSingleStep/dispatchFanoutStep/finalizePrimary/runContainer, every gate decision branch (advance incl. fanout re-entry, reject + dedup arms, request-changes + dedup), and every reconcile transaction (pipeline-unfinalized, fanout-parent recovery both arms, mid-provisioning, container-gone variants, empty-result backfill, invoke-like completion). The write⇒probed content guard ends at ZERO deferred gaps: every state-write in the three files is probed or argued non-window with machine-checked reasons. Kill-vs-smoke cell semantics named per cell; whole-registry kill guarantee (coverage test + throw-by-name).
- **Five invariant assertions per cell, all pass on HEAD**: matrix 940 integration cells + 129-test worktree lane, green with exactly the known-failure todos. Invariant 4 upgraded to file-level worktree snapshots and exercised over REAL git worktrees (14 worktree-touching kill points); invariant 5 upgraded to lossless SELECT-* snapshots naming the moved column.
- **Meta-AC**: the pre-FG-427/FG-482 blocked_by_red two-write dance seeded as a fixture and flagged; plus detection-power fixtures proving each of the five checkers catches a hand-written violation (with passing controls), the fixpoint cap fails loudly, and the reconcile crash model cannot be swallowed by never-throw guards.
- **Wired into test:extended**: matrix + detection in the integration tier, the worktree lane in the worktree tier — both inside CI's test-extended job (evidence reused by the loop at the exact tip).
- **Zero production behavior change**: only inert probe callsites (bare-literal args content-guarded; production may import only crashPoint; the shared harness is test-support with an import ban guard).
- **Real bugs FILED, not fixed**: FG-531 (awaiting_red wedge, single-step + fanout-parent variants — 2 pinned cells), FG-532 (gate reject discards the rejected result), FG-533 (pre-container running wedge) — four known-failure cells total, each flipping to a passing assertion when its ticket lands. Worktree-leak evidence recorded in FG-356.

Gates: review-loop closeable (run-review-loop-fg-530-1815ec; tip 96b9ede = remote head; CI test + test-extended evidence reused at that sha). The operator's 2026-07-11 ruling (build the coverage, do not narrow) is fully implemented. Docs impact: **updated** — docs/how-to-testing.md (crash-matrix conventions, three-list lockstep, kill-vs-smoke semantics, known-failure pins incl. FG-533).
