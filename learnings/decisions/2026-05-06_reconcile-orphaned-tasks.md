# Decision: Reconcile orphaned tasks at the top of every `forge next` and `forge status`

> **Scope note (amended).** The core decision — reconcile at the top of every `forge next` / `forge status`, act on durable evidence, stay idempotent — holds. But the "only acts on tasks in `running` status" claim below is no longer an accurate description of reconcile: the sweep has since widened to fanout parents (FG-455), `pending` duplicate primaries, and — since FG-531 — `awaiting_red` tasks whose reds died with the process, plus their dead `pending`/`running` red rows. Since FG-533 it also sweeps the *pre-container* window: a workflow-dispatched, non-manual, childless `running` task with no `container.started`, no live agent container, and no live run-lock holder is failed as the retryable `pre_container_crash` — the one `running` shape the container-gone sweep deliberately skipped, because a container it could probe never existed. Idempotence is still the invariant; `running` is no longer the boundary, and neither is "reconcile only acts where a container ran." See [Orphaned task recovery](../../docs/concepts.md#orphaned-task-recovery).

**ID**: FORGE-DEC-009
**Date**: 2026-05-06
**Status**: Decided
**Decided by**: Steven (forge build, hit during first parallel red dispatch)
**Supersedes**: N/A
**Scope**: forge

---

## Context

During the first end-to-end run with parallel red agents, a red task wrote its `result.json` to disk and the docker container exited cleanly, but the parent forge process never observed the docker child's `'close'` event. The DB row stayed `running` forever; the verdict was never recorded; the parent blue task never transitioned to `awaiting_gate`. The user saw a task "running for some time now" with no container alive on the host.

This is a class of failure, not a one-off. Possible causes:
- Forge process exited before docker child fired `'close'` (terminal closed, SIGINT didn't propagate, parent crashed)
- macOS Docker Desktop's CLI can disconnect mid-stream while leaving the docker process alive but unreachable
- An unhandled promise rejection somewhere in the spawn pipeline silently dropped the resolution

The agent did its job correctly in every one of these. Forge just missed the bridge moment between "container exited" and "DB updated."

---

## Problem

**How should forge recover when an agent finishes but the spawn pipeline doesn't observe the finish?**

---

## Options Considered

### Option A: Make the spawn pipeline bulletproof

Add `process.on('unhandledRejection')`, increase robustness in `runDocker`, add timeouts, polled liveness checks on the docker process.

**Pros**: prevents the orphan from being created in the first place.

**Cons**: chasing every individual cause is a long tail; we can't catch the case where forge itself is killed (signal, terminal close, OS reboot). Each new defense is its own potential bug.

---

### Option B: Reconcile on next operation ✅

At the start of `forge next` and `forge status`, scan tasks in `running` status. If `result.json` exists and is parseable, finish the task the same way `spawn()` would have: parse the result, write any verdict to the verdicts table (when the task is a red), transition the parent's status (awaiting_gate or blocked_by_red). If the result file is missing or empty, leave the task alone — it might still be running.

**Pros**:
- Idempotent: tasks not in `running` are skipped; results already on disk are authoritative
- Recovers from every orphan-cause without diagnosing which one happened
- Cheap: a few stat() calls and JSON parses per `forge next` invocation
- Independent of the failure mode — works whether forge died, docker disconnected, or a promise leaked

**Cons**:
- Reconciliation runs on every `next` and `status`, adding a small startup cost (negligible — disk reads of files we'd open anyway)
- A red whose `result.json` is partially written would be classified as "still running" and skipped — not a bug, but a corner case

---

### Option C: Daemon mode that polls task state

Run forge as a long-lived process that polls running tasks.

**Cons**: contradicts the design's explicit "no daemon" stance (sketch line 28). The whole appeal of forge is that state lives in SQLite and the CLI is fire-and-resume.

---

## Decision

**Chose**: Option B — reconcile on next operation.

**Rationale**: SQLite is already the resume state for forge. Reconciliation extends that pattern to "result files on disk are also authoritative." This matches the existing design ethos: the spine recovers from interrupted state rather than trying to prevent interruption. Bulletproofing the spawn pipeline (Option A) is still worth doing for *some* causes, but reconciliation is the safety net that makes all causes survivable.

The reconciler is in its own module (`src/v2/reconcile.ts`) so the `next.ts` and `status.ts` integration points are one-liners.

---

## Consequences

**Positive**:
- An orphaned task is recovered automatically the next time the user runs any forge command
- The user doesn't need to know which command "fixes" the run — `forge status` shows reconciled output, `forge next` proceeds from the reconciled state
- A `(reconciled N orphaned task(s))` line surfaces when reconciliation actually did something, so the user is informed without being interrupted

**Negative / Trade-offs**:
- Two slightly different code paths now finish a task: `spawn()` for the live case, `reconcile()` for the recovered case. Logic duplication is small but real (verdict write, status transition). Mitigated by both calling the same store functions
- Reconciliation only sees parent/child relationships through the DB — if the workflow definition no longer matches what was running (e.g., a phase was renamed mid-run), reconciliation skips silently rather than crashing

**Risks**:
- A truly broken `result.json` (parseable JSON but garbage content) would be marked complete with garbage. Mitigation: agents have a strict output schema; future work could add schema validation in reconcile

---

## Implementation Notes

- `src/v2/reconcile.ts` — `reconcileRun(runId, workflow)`. Reads tasks via `tasksForRun`, processes each `running` task whose `result.json` exists.
- Idempotency: the reconciler only acts on tasks in `running` status. A task already `complete`/`failed`/`awaiting_gate`/etc. is skipped, so re-running reconciliation is safe.
- Red verdict path: when reconciling a task with a `parentId` whose phase declares reds, the reconciler writes the verdict row AND transitions the parent's status (`blocked_by_red` for authoritative-fail-with-gate, `awaiting_gate` otherwise). It only mutates the parent if the parent is in `complete` or `running` (i.e., still pre-gate); a parent the user already gated is left alone.
- `forge status` reconciles before reporting so the displayed state matches reality. `forge next` reconciles before the dispatch loop so it can pick up where the orphan left off.
- Logged events on reconciliation include `payload: { reconciled: true }` so the audit trail is honest about how a task got finished.

---

## Revisit Conditions

- If the streaming output format changes such that `result.json` is partial-by-default (e.g., NDJSON), update the parser to consume the file as a stream
- If a workflow ever needs to *intentionally* leave a task in `running` for hours (heavy reasoning), add a `task.long_running: true` flag and skip those in reconciliation
- If reconciliation starts firing for tasks whose containers are still alive (false positive), add a docker `ps`-based liveness check before declaring orphan
