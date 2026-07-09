---
id: FG-365
type: story
status: active
title: "FG-350 follow-up: loadModelPolicyWithSource re-reads model-policy per container dispatch (O(N+M) file reads)"
created: 2026-06-22
---

**Found:** 2026-06-22, red-wide review of the FG-350 control-plane-receipts implementation.

## Problem

`runContainer` (src/v2/runNext.ts) calls `loadModelPolicyWithSource()` once per container dispatch to build the controlPlane receipt — so a fan-out of N children plus M reds performs N+M redundant reads/parses of the same `model-policy.yml`. Functionally correct (the receipt is right), purely a perf/IO concern.

**Why deferred:** non-blocking, no correctness impact. Filed as a follow-up so it is not lost; FG-350 landed without it.

## Goal

Resolve the model-policy provenance once per run/dispatch wave (or memoize per projectDir) and reuse it across container dispatches: receipt content unchanged, file reads O(1) per wave instead of O(N+M).

**Fix sketch:** memoize the resolved model-policy provenance per (projectDir) for the duration of a run/wave, or resolve once at run/wave start and pass through `controlPlaneInputs` like workflowReceipt/routeReceipt already are. Apply the same to any other per-container loader reads if trivially cheap.

## Acceptance Criteria

- [ ] Model policy is loaded/parsed at most once per dispatch wave (or memoized per projectDir at no coarser than per-run granularity), not once per container.
- [ ] controlPlane receipt content is unchanged for the same inputs (same resolved policy + provenance recorded as today).
- [ ] A test asserts single-load behavior across a multi-child fan-out dispatch (loader spy/counter through the real dispatch path).
- [ ] Memoization is keyed such that different projectDirs (or a changed policy between runs) still resolve correctly — covered by a test or by construction (per-wave scope).

## Non-Goals

- Broader loader/config caching beyond this receipt-assembly path.

**Scope:** small, isolated to runNext.ts receipt assembly.
