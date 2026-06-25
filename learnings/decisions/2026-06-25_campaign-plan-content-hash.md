# Decision: Fingerprint campaign plans by sha256 over canonicalized plan content

**ID**: FORGE-DEC-023
**Date**: 2026-06-25
**Status**: Decided
**Decided by**: Steven
**Supersedes**: N/A
**Scope**: forge

---

## Context

FG-391 introduced `planCampaign()` and `computePlanHash()` in `src/campaign/planner.ts`. A campaign plan resolves a ticket list or epic into an ordered set of items and records the plan durably (via the FG-390 campaign model). No execution happens at this stage.

FG-392 will execute an approved campaign. Before execution, it must verify that the current resolved plan matches the plan the operator approved — a re-plan that changes meaning must be rejected; a re-plan that differs only in volatile metadata (timestamps, generated ids) must not require a new approval cycle.

---

## Problem

How do we compare "the approved plan" against "the current plan" in a way that is stable across re-runs of the same logical plan but sensitive to any change in plan meaning?

---

## Decision

A campaign plan is fingerprinted by **sha256 over its canonicalized plan content** (`CanonicalPlanContent` in `planner.ts`). The hash is stored in the `plan_hash` column on the `campaigns` table and in campaign metadata (`metadata.planContent`).

**Canonical content** includes:

- `resolvedItemIds` — the ordered list of resolved ticket ids
- `mode` — campaign execution mode (`dry_run`, `pilot`, `sequential`)
- `sourceInput` — normalized representation of the operator input (kind, ticketIds / epicId / additions / exclusions)
- `branchPrStrategy` — per-item branch/PR policy
- `readinessGateAvailability` — whether the FG-382 readiness preflight is available
- `plannerAssumptions` — any assumptions the planner recorded (e.g. gates unavailable, dependency decisions deferred)
- `advisoryAgentsUsed` — whether advisory agents influenced ordering
- `advisoryRecommendationSummary` — their summary, if any
- `dependencyDecisions` — explicit dependency ordering decisions

**Canonicalization** uses recursive key-sorting (`sortKeysDeep`) before `JSON.stringify`, so object key insertion order cannot affect the hash.

**Excluded from hash input** (volatile fields): campaign id, item ids, run ids, timestamps, created/updated metadata. These must not cause a content-equivalent plan to hash differently.

---

## Rationale

A content hash rather than a random plan id:

- Two invocations of `planCampaign()` with identical inputs and the same backlog state produce the same hash. An operator can re-plan (e.g. after a restart) and proceed without re-approval if nothing changed.
- Any change to the resolved id set, order, mode, or planner assumptions changes the hash, so the FG-392 pre-execution check catches meaningful drift automatically.
- Random plan ids would require explicit re-approval on every re-plan regardless of whether anything changed, which is friction without safety benefit.

---

## Consequences

**Positive**:

- FG-392 gets a simple, reliable pre-execution check: compare `campaigns.plan_hash` (approved value) against `computePlanHash(currentCanonicalContent)`. Match → proceed; mismatch → re-plan required.
- Re-plans that change nothing (same inputs, same backlog state) are free: same hash, no re-approval.
- Plan identity is auditable: `metadata.planContent` stores the full canonical content alongside the hash.

**Negative / Trade-offs**:

- **Adding a field to `CanonicalPlanContent` is a breaking change to plan-approval matching.** Any new field becomes part of every future hash. Existing stored hashes become invalid (stale plans will fail the FG-392 pre-execution check). Add fields deliberately and document the migration path.
- Removing or renaming a field from `CanonicalPlanContent` similarly invalidates stored hashes. Treat the type as a stable contract once FG-392 is in use.

---

## Implementation Notes

- `computePlanHash()` is a pure function with no I/O. Test it with synthetic `CanonicalPlanContent` values; do not rely on database state.
- The `plan_hash` column is nullable (`TEXT NULL`). Null means the campaign predates FG-391 or was created by a path that did not call `setPlanHash`. FG-392 must treat null as "unapproved" and require re-plan before execution.
- `planCampaign()` does not execute. Campaigns are created with status `planned`; items are created with status `pending`. No run or task rows are written. FG-392 owns execution.

---

## Revisit Conditions

- **FG-392 is built and adds execution-side fields to the canonical content.** Reassess which fields belong in the hash at that point. If execution concerns (e.g. retry policy, agent config) need to influence the hash, they must be added to `CanonicalPlanContent` deliberately.
- **Stored hashes become stale at scale** (many approved campaigns in flight when `CanonicalPlanContent` changes). If that becomes a maintenance burden, consider a schema-version prefix on the hash (e.g. `v1:<sha256>`) so FG-392 can distinguish "wrong schema version" from "plan changed."
