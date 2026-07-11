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


## Session handoff (2026-07-11, autonomous queue item 5 — STOPPED on a scope call, work NOT merged)

**State: PR #103 open on feat/fg-530-crash-point-simulator (tip ad5feb3, pushed; CI pending at tip, green at every prior commit). NOT merged — the review-loop never passed, so merge stays blocked, correctly.**

What is on the branch, all green in-loop (matrix ~330+ tests / 2 todo = the filed FG-531/FG-532 bugs; unit/integration/worktree tiers green; typecheck clean):
- The v1 harness: inert crash hook + probes across dispatchSingleStep post-container, gate decision writes (incl. FG-353 fanout force-advance re-entry + dedup arms), reconcile writes (pipeline-unfinalized, fanout-parent recovery both arms, empty-result backfill, invoke-like completion); 5 scenarios; five named invariant checkers (checker 1 mirrors the FG-523 fanout-parent carve-out); meta-AC two-write-dance fixture; FG-530-A/B known-failure cells (= FG-531/FG-532).
- Self-verification: probe-inertness (literal-args content guard, no hook stacking/leak), detection-power fixtures for all five checkers, fixpoint-cap loudness, three-way lockstep (callsites == KILL_POINTS == PROBE_NAMES).
- The FG-516-style construction guard: every state-write in the three surfaces must be probed or carry a reasoned ALLOWLIST entry (reasons machine-checked, gap-ratcheted).
- docs/how-to-testing.md documents the conventions.

**The open question the queue stopped on (operator call):** the review-loop churned 3 runs (needs_fix_max_rounds x2 after the construction guard) — each round the reviewer converts allowlisted exceptions into demanded coverage. Round-2 residual: three remaining allowlisted crash windows (incl. reconcile's mid-provisioning failure transaction) with the reviewer's own alternatives: (a) build reachable fixtures + probes/cells for them, or (b) NARROW THE TICKET'S STATED SCOPE (make v1's AC name the reasoned-allowlist boundary as the coverage contract instead of exhaustive enumeration). (b) matches the ticket's original "v1 scope, deliberately tight" intent; (a) is more coverage but the provisioning fixture is nontrivial. Decide, then either dispatch the fixture work or edit this AC + re-run `forge review-loop FG-530 --max-rounds 2 --route implementation_quick --since f123de5` — the rest of the review is clean.

Review-loop trails: ~/.forge/runs/run-review-loop-fg-530-{362180,ec228b,11aac6}/.
