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

- A process holding `forge campaign start` overnight has no automatic recovery path if it dies. The campaign stays stuck in `running`; manual SQLite recovery is required (no automated reset command yet). `forge campaign show` reveals which item was in flight.
- Sequential throughput is bounded by engineer-agent wall-clock time per item. Multi-item campaigns on large epics will be slow. Parallel dispatch is still deferred.

---

## Revisit Conditions

- **FG-393 shipped blocker/continue policy** (see Extension below). The CAS-only concurrency model still suffices — FG-393 did not introduce parallel dispatch.
- **Parallel dispatch deferred.** When parallel execution ships, re-evaluate whether the single CAS guard on `planned → running` is sufficient or whether per-item dispatch guards are needed.
- **FG-394 shipped** `show`, `report`, `pause`, `resume`, `abandon` (no `reset` command). At that point the interim SQLite manual-recovery procedure in docs/concepts.md was still the only path — a crashed `running` campaign required manual DB intervention. Cooperative-pause, resume-as-active-driver, and atomic CAS terminal transitions are documented in docs/concepts.md (Campaign lifecycle / Pause / Resume sections); no new ADR was warranted because these are extensions of the same sequential-CAS execution model captured here.
- **FG-564 shipped automated crash recovery** (2026-07-20), retiring the manual-SQL procedure referenced above. A crashed `running` campaign is now recovered with `forge campaign recover` (per-wake sibling: `forge campaign continue`), gated on a durable campaign-controller lease (`campaign@<campaignId>@<controllerInstanceId>`, with owner/generation/expiry). A replacement fails closed while the prior lease is live and takes over only after it expires; the "manual recovery" consequence and the "no automated reset command yet" trade-off recorded above are superseded. See docs/concepts.md (Crash recovery).

---

## Extension: Blocker/continue policy (FG-393)

**Date**: 2026-06-25  
**Status**: Decided  
**Decided by**: Steven

### Context

FORGE-DEC-024 deferred partial-failure semantics: "cross-item dependency management and partial-failure semantics are unsolved at this stage." FG-393 ships those semantics. The sequential-dispatch and CAS-concurrency decisions above remain unchanged.

### Decision

Item failures are classified as SHARED (system-level) or LOCAL (agent-level) and handled conservatively:

**SHARED blockers hold the whole campaign.** Auth, infrastructure, container crash/orphan/idle timeout, malformed or missing result, git state, dependency install, merge conflict, and thrown dispatch errors are SHARED. The campaign transitions `running → paused` (resumable); remaining items stay `pending`. The operator fixes the shared condition and runs `forge campaign resume`.

**LOCAL blockers apply the dependency policy** using ticket `related` metadata only — no deeper inference. The blocked item is recorded with `outcome: blocked` and the runner evaluates each remaining pending item:
- Dependent (either ticket's `related` lists the other) → held in both sequential and pilot mode.
- Unknown (blocked ticket has no `related`) → held in sequential; continues in pilot.
- Independent (blocked ticket has `related`, but it does not include the later ticket) → continues in both modes.

Held items preserve `lifecycleStatus: pending` with `outcome: held` and an exact reason string. They are never silently skipped.

**Campaign end-state:** if any held items remain after all items are processed, the campaign transitions `running → paused` (awaiting resume). If none are held, it transitions `running → complete`. A complete campaign with blocked/held/skipped items reports `verdict: complete_with_issues`, never `all_shipped`.

**Resume reconsiders held items:** `forge campaign resume` rebuilds the blocked set from still-failed LOCAL items, frees held items whose blockers are resolved, and re-dispatches them. Still-blocked dependents stay held. `resume` does not retry the failed/blocked item itself.

**Pilot mode** overrides only the UNKNOWN relation — it never continues past a known dependency and never overrides a SHARED blocker.

### Alternatives considered

- *Per-item opt-in via campaign flags.* Rejected: conservative defaults protect the operator from silent cascading failures; pilot mode already provides the opt-in for the UNKNOWN case.
- *Deep ticket-graph inference (transitive dependencies).* Rejected: the `related` field is the declared contract; inferring undeclared dependencies would be surprising and error-prone.
- *Stop-on-any-failure (pre-FG-393 behavior).* Superseded: too conservative for LOCAL blockers with declared-independent later items; offered no value for operators who know the remaining work is independent.

### Consequences

- Operator visibility is improved: blocked/held items surface with exact reason strings and `requestedHumanAction` in `forge campaign show` and `forge campaign report`.
- `running → failed` is no longer triggered by item failures. The `failed` campaign status remains a valid terminal state for pre-FG-393 campaigns in the database.
- The `item_failed` stop reason is defined in `CampaignStopReason` for type completeness but is not returned by the current dispatch loop.
