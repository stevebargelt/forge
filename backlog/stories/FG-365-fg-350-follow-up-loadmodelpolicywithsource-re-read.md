---
id: FG-365
type: story
status: active
title: "FG-350 follow-up: loadModelPolicyWithSource re-reads model-policy per container dispatch (O(N+M) file reads)"
created: 2026-06-22
---

**Found:** 2026-06-22, red-wide review of the FG-350 control-plane-receipts implementation.

**Issue:** `runContainer` (src/v2/runNext.ts) calls `loadModelPolicyWithSource()` once per container dispatch to build the controlPlane receipt — so a fan-out of N children plus M reds performs N+M redundant reads/parses of the same `model-policy.yml`. Functionally correct (the receipt is right), purely a perf/IO concern.

**Why deferred:** non-blocking, no correctness impact. Filed as a follow-up so it is not lost; FG-350 lands without it.

**Fix sketch:** memoize the resolved model-policy provenance per (projectDir) for the duration of a run/wave, or resolve once at run/wave start and pass through `controlPlaneInputs` like workflowReceipt/routeReceipt already are. Apply the same to any other per-container loader reads if cheap.

**Scope:** small, isolated to runNext.ts receipt assembly.
