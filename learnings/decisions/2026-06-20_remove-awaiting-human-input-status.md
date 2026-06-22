# Decision: Remove `awaiting_human_input` task status

**ID**: FORGE-DEC-020
**Date**: 2026-06-20
**Status**: Decided
**Decided by**: Steven
**Supersedes**: FORGE-DEC-016
**Scope**: forge

---

## Context

FORGE-DEC-016 introduced `awaiting_human_input` as a new `TaskStatus` value alongside an "empty-agents phase" (`agents: []`) shape and a `forge submit <task-id>` command. The idea was to park a single task in `awaiting_human_input` while a human produced artifacts outside forge (Pencil/design exports), then transition to `awaiting_gate` on explicit `forge submit`.

None of that wiring was ever built:

- `forge submit` does not exist — no command file, not registered in the CLI.
- No workflow uses an `agents: []` phase.
- `src/v2/runNext.ts` has no branch that creates tasks in `awaiting_human_input`; the empty-agents path from the ADR was never implemented.
- As a result, nothing in the codebase ever *produces* this status. It exists only in consumers (status-switch arms, dashboard render paths, advise output) that handle a state that can never occur.

The human-in-the-loop design need that FORGE-DEC-016 was trying to address is already served by a different mechanism: `forge design` (FORGE-DEC-014), which tracks a host-side Pencil session without requiring a task-status detour through forge's state machine. FORGE-DEC-016 was effectively superseded by FORGE-DEC-014 before `awaiting_human_input` was ever wired up.

Per CLAUDE.md, `tasks.status` values are a protected primitive — both additions and removals require an ADR.

---

## Problem

`awaiting_human_input` is a task status that:

1. Nothing produces.
2. Everything must handle (dead code in every status switch).
3. Misleads future readers into thinking a "manual phase / forge submit" mechanism exists.

Keeping it imposes ongoing maintenance cost with zero runtime benefit.

---

## Decision

**Remove `awaiting_human_input` from the `TaskStatus` union** and delete all dead handling code for it.

The valid `tasks.status` values after this removal are:

```
pending | running | awaiting_gate | awaiting_red | complete | failed | blocked_by_red
```

---

## Rationale

- **Nothing produces it.** A status with no entry path is dead state. Dead state makes the state machine harder to reason about — every reader must wonder "can this actually occur?"
- **The design need is covered.** The human-input-during-design use case is served by `forge design` (FORGE-DEC-014). No gap is opened by removing this status.
- **Dead handling code is misleading.** Switch arms and render paths for `awaiting_human_input` imply the status is reachable. Removing them makes the actual state machine legible.
- **The `forge submit` command was never built.** The mechanism FORGE-DEC-016 depended on was never implemented, so the status was stranded from the start.

---

## Consequences

**Positive**:
- State machine has seven statuses instead of eight; every status is reachable and producible.
- Dead code branches removed across `dispatch.ts`, `gate.ts`, `advise.ts`, `next.ts`, `store/tasks.ts`, dashboard renderer, and CLI commands.
- No risk to existing data: no row in `tasks.status` has ever been set to `awaiting_human_input` (the entry path was never wired). No migration needed.

**Negative / Trade-offs**:
- If a future workflow genuinely needs a "human produces artifacts off-forge" phase, the `awaiting_human_input` + `forge submit` design in FORGE-DEC-016 remains a valid reference point. It would need to be re-introduced with a new ADR and full implementation (including `forge submit` and the empty-agents branch in `next.ts`).

---

## Revisit Conditions

- **A workflow that genuinely needs a "human artifact production" phase is added.** Consult FORGE-DEC-016 as the design reference, implement `forge submit`, and introduce a new status (or re-introduce this one) with a new ADR.
