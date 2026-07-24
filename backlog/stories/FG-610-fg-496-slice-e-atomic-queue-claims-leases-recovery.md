---
id: FG-610
type: story
status: active
title: "FG-496 Slice E: atomic queue claims, leases, recovery, capacity accounting + canonical claim-next query (consumed by FG-591)"
created: 2026-07-24
---

## Slice E of FG-496 — atomic queue claims + canonical claim-next query

Deliver the durable claim/lease/recovery primitives and the single canonical atomic claim-next query that
FG-591's dispatcher later consumes. This slice delivers **primitives only** — NO running dispatcher, NO UI.
Reuse the existing cross-process CAS + lease-fencing precedent rather than inventing a new mechanism.

## Scope

- **`queue_claims`** with owner / lease-expires + heartbeat / claimed ticket revision / launch-run identity /
  release-terminal outcome, so a dispatcher can recover without duplicate execution.
- **Expired-lease recovery** — a crashed controller's claim is taken over only after its lease expires.
- **Capacity accounting** — cannot exceed a configured active-run capacity under concurrent dispatchers.
- **Canonical atomic claim-next query** — scans canonical rank order, applies a caller-supplied deterministic
  eligibility/compatibility predicate, and atomically claims the first eligible ticket without exceeding
  capacity. Persist enough scheduling evidence to distinguish blocked / readiness-ineligible / already-claimed
  / temporarily-incompatible-with-active-runs **without mutating canonical rank**.

## Files (grounded)

- `src/store/schema.ts` — `queue_claims` table.
- new `src/store/queue-claims.ts` — `BEGIN IMMEDIATE` CAS, modeled on
  `src/store/continuations.ts:claimContinuationDispatch` and the `campaign_controller_leases` fencing pattern.
- Reuse precedent: `src/store/fg562-claim-worker.ts` (cross-process CAS race harness),
  `schema.ts` `campaign_controller_leases` (generation fencing token),
  `schema.ts` `campaign_item_launches` (born-under token per attempt).

## Acceptance Criteria

- Concurrent claim race produces **no duplicate execution**; capacity never exceeded under concurrent dispatchers.
- Expired lease recovered without duplicate execution.
- claim-next scans canonical rank order and honors the caller eligibility/compatibility predicate.
- Scheduling evidence distinguishes blocked / readiness-ineligible / already-claimed / temporarily-incompatible
  without mutating rank.
- A real cross-process race test (fg562 precedent) proves the concurrency guarantees.
- Additive schema only; no `user_version` bump; per-slice migration test.

## Dependencies / Relations

- Parent: FG-496. Epic: FG-593.
- Depends on: Slice D (FG-609, the rank/membership/readiness fields the claim-next query scans).
- Consumed by: FG-591 (the running dispatcher + `max_active_runs` capacity control).
- Concurrency guarantees must be validated with a HOST stress-loop, not a single/30x run or a container pass
  (per Forge concurrency-fix policy).

## Non-Goals

- No running dispatcher, no `max_active_runs` operator control, no Kanban/UI — all FG-591. FG-496 stops at the
  canonical claim-next query the dispatcher calls.
