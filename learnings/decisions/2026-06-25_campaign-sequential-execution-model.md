# Decision: Campaign execution model — approval gate, CAS concurrency, sequential dispatch

**ID**: FORGE-DEC-024
**Date**: 2026-06-25
**Status**: Decided
**Decided by**: Steven
**Supersedes**: N/A
**Scope**: forge campaign executor (FG-392)

---

## Context

FG-391 introduced campaign planning (FORGE-DEC-023: plan content hash). FG-392 adds execution. Three design questions arose at the execution layer that FORGE-DEC-023 deliberately left open:

1. How should operator authorization be recorded and enforced?
2. How do we prevent two concurrent `forge campaign start` invocations from dispatching the same work?
3. How many items should run in parallel in the MVP?

---

## Decisions

### 1. Approval is a durable state-machine precondition, not a flag

`forge campaign approve` is a CLI command that records `approved_by`, `approved_at`, `approval_rationale`, and snapshots `plan_hash → approved_plan_hash` as a database write on the `campaigns` row. `forge campaign start` refuses (`not_approved`) if `approved_plan_hash` is null.

Approval is enforced before the `planned → running` CAS so that there is no window in which an unapproved campaign can transition to `running`. The approval record is permanent — it is never overwritten by a subsequent `forge campaign start`.

**Alternatives considered:**

- *Advisory annotation only (no enforcement at start).* Rejected: the approval would be cosmetic; an operator typo or a forgotten step could silently start work on an unapproved plan.
- *Require re-approval on every start.* Rejected: `start` already re-validates the plan hash; requiring a new approval record on retry would be unnecessary friction.

### 2. Planned → running compare-and-swap (CAS) as the concurrency guard

The transition from `planned` to `running` is executed as a single SQL `UPDATE … WHERE id = ? AND status = 'planned'` that returns the number of changed rows. If the row count is zero, `start` returns stop reason `already_running` and exits non-zero without dispatching any work.

The CAS is the last precondition check (after all content checks including stale-plan) so that a concurrent `start` only loses at the CAS if it would otherwise proceed — the first caller does not block the second from reporting a stale-plan error early.

**Alternatives considered:**

- *File lock or external semaphore.* Rejected: the campaign state is already in SQLite; a second locking mechanism adds a separate failure surface and a dangling lock if the process crashes.
- *Application-level mutex.* Rejected: only guards concurrent calls within a single process, not across terminals or CI jobs on the same host.

### 3. Sequential dispatch (one item at a time, MVP)

Items are dispatched to the engineer agent one at a time with `await` between each. No fan-out. The CAS makes it structurally impossible for two `start` invocations to dispatch concurrently.

Crash recovery is explicitly deferred to FG-394. A process death leaves the campaign in `running` with durable `run_id` evidence per item, and the operator recovers manually via direct SQLite writes until FG-394 ships.

**Alternatives considered:**

- *Parallel dispatch (N concurrent engineer agents).* Deferred to a future ticket (FG-393). Sequential is the conservative choice for the MVP because cross-item dependency management and partial-failure semantics are unsolved at this stage.
- *Automated crash recovery.* Deferred to FG-394. Pre-allocating and persisting `run_id` before each dispatch is the minimum evidence footprint that makes manual recovery unambiguous.

---

## Consequences

**Positive:**

- Approval is auditable: `approved_by`, `approved_at`, `approval_rationale`, and `approved_plan_hash` are durable records on the campaign row.
- The CAS eliminates double-dispatch without any external locking infrastructure. Host stress-tested at 40 rounds × 24 concurrent processes.
- Sequential execution is simple to reason about and test; failure attribution is unambiguous.

**Negative / Trade-offs:**

- A process holding `forge campaign start` overnight has no automatic recovery path if it dies. The operator must use interim manual SQLite recovery until FG-394 ships.
- Sequential throughput is bounded by engineer-agent wall-clock time per item. Multi-item campaigns on large epics will be slow. FG-393 addresses this.

---

## Revisit Conditions

- **FG-393 ships continue/blocker policy or parallel execution.** Re-evaluate whether the CAS-only concurrency model still suffices.
- **FG-394 ships resume/reset.** Document the `forge campaign reset` command and retire the interim SQLite manual-recovery procedure from docs/concepts.md.
