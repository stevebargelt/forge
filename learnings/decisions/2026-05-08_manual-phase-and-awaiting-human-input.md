# Decision: Manual phases and the `awaiting_human_input` task status

> **Superseded by [FORGE-DEC-020](2026-06-20_remove-awaiting-human-input-status.md)** — `awaiting_human_input` has been removed from the state machine. The `forge submit` mechanism described here was never implemented; see FORGE-DEC-020 for the removal rationale.

**ID**: FORGE-DEC-016
**Date**: 2026-05-08
**Status**: Superseded
**Decided by**: Steven (planning #54 with Claude)
**Supersedes**: N/A
**Scope**: forge

---

## Context

FORGE-DEC-014 established that `ui-design` and `design-revise` workflows have an unavoidable **human-in-the-loop step that runs outside forge** — the human runs PROMPT.md against Pencil on their host. The brief phase already works (prompt-author writes PROMPT.md, human reviews via the dashboard, human gates). What's missing is the second half: a phase where forge holds a slot for "the human is producing the artifact right now, come back when done."

#54 (BACKLOG) tracks the workflow-shape side of this. The remaining architectural question is **how to represent a phase that has no agent to dispatch.** Today every phase shape forge knows about assumes `dispatch()` runs a container, captures result.json, then either auto-completes or transitions to `awaiting_gate`. A phase whose only "compute" happens on the human's laptop has no container to run, no result.json to capture, and no natural moment to transition into the gate state.

Without a primitive for this, the only options are (a) skip the review phase (lose the artifact-rendering surface, lose the reject-loops-to-brief escape hatch), or (b) hack a fake agent that does nothing in a container (lies in the audit trail, wastes spawn time, and adds a no-op to the seeds catalog forever).

This is a meaningful state-machine addition: a new task status (`awaiting_human_input`) and a new phase shape (`agents: []` + the runtime semantics that go with it). Per CLAUDE.md ("the state-machine status values in `tasks.status` ... is a schema change and an ADR"), this needs a decision record.

---

## Problem

How does forge represent a workflow phase whose work is performed by the human outside forge — such that:

1. The dashboard can show "the human owes us artifacts" as a distinct, recognizable state (not conflated with `awaiting_gate` or `pending`).
2. The transition from "human is working" → "human has produced artifacts" is explicit and validated, not inferred.
3. The phase still participates normally in gating, reject-loops, reds (when added later), and run finalization.
4. No new fake-agent shim is added to seeds; the container invariant ("agents always run in containers") remains intact because there is no agent.

---

## Options Considered

### Option A: sentinel "human" agent that no-ops in a container

Define a special `human` agent ref. `dispatch()` recognizes the role and short-circuits — no container spawn, just a status flip. The phase looks like a normal agent phase from the type system's perspective.

**Pros**:
- No new task status; reuses `awaiting_gate`.
- Workflow type system unchanged.

**Cons**:
- Lies in the audit trail: `tasks.agent_role = "human"` but no agent ran. Future readers of the DB will be confused.
- Adds a `seeds/agents/human/` directory that exists only to satisfy the type system. Dead weight forever.
- Conflates "the human is producing the artifact" with "the human is reviewing what an agent produced" under one status. The dashboard can't tell them apart without inspecting agent_role for the `"human"` sentinel.
- Doesn't compose with reds when they're added: red plumbing fires on `runBlueTask` completion. A no-op blue creates a degenerate red trigger.

---

### Option B: empty-agents phase + new `awaiting_human_input` status ✅

Add `awaiting_human_input` to the `TaskStatus` union. A phase with `agents: []` is a manual phase: when `next` would normally create tasks for it, it creates exactly one task and parks it in `awaiting_human_input`. The human transitions it out via an explicit `forge submit <task-id>` command (CLI + dashboard button), which validates that the artifacts the human was supposed to produce actually exist on disk, captures their paths into `task.result`, and transitions to `awaiting_gate` (where the existing gate machinery takes over — including reds when they land per #49).

**Pros**:
- The new status is the architectural truth. Distinct from `awaiting_gate` because the human is *producing* not *deciding*. Dashboard can render different UI for each.
- Audit trail stays honest: `agent_role` is empty, no container ran, but the task row exists with the artifact paths it captured.
- Composes naturally with reds: the submit step is the equivalent of `runBlueTask` completing — same hook point for spawning reds against the human's output.
- Reuses `onReject` unchanged: rejecting a `review` phase loops back to `brief` per the existing rationale-propagation code path (#25).
- Seeds catalog stays clean — no fake-human-agent dir.

**Cons / Trade-offs**:
- Adds one task status (5 → 6 if you count by tasks.status). Schema change. Code paths in `next.ts`, `dispatch.ts`, `gate.ts`, `advise.ts`, store accessors, dashboard renderer all need to recognize the new status. (The state machine has been stable since launch; this is the first addition.)
- Requires a new `forge submit` command and matching dashboard endpoint. ~150 LOC plus tests.
- The artifact-path validation is workflow-specific (ui-design knows about `.pen` + `designs/*.png` + `code/*.html`); the `submit` command needs a way to know what to validate. Solved by reading `run.metadata.designDir` + the workflow's known conventions.

---

### Option C: gate-time submission (one phase, two-stage gate)

Skip the second phase entirely. The brief phase's gate becomes "submit artifacts AND decide" — the human pastes paths and gates in one step.

**Pros**:
- No new status. No new phase shape.

**Cons**:
- Conflates two distinct moments: "the prompt is good, run it" and "the design is good, advance." If the human runs PROMPT.md, doesn't like the result, and wants to revise the prompt, the gate UX has no clean way to say that without reject-then-rebuild.
- The dashboard can't show "design in progress" between brief-approval and review — there's no task in flight.
- Reds (when added) have nothing to attach to; they'd run on a gate decision rather than a task output.
- Fights forge's own model: gates are decisions, not data-entry surfaces.

---

## Decision

**Chose**: Option B — empty-agents phase + new `awaiting_human_input` status.

**Rationale**:
- Adding the status is the cheapest honest representation. The state-machine cost is one entry; the readability and composition wins justify it.
- This is exactly what the CLAUDE.md exception (state-machine changes need an ADR) is designed for. The work is small and the benefit is structural.
- The `forge submit` command is reusable: any future workflow with a human-produced artifact step (printed mockup, recorded interview, hand-edited spec) can use the same primitive.
- Option A's audit-trail lie compounds over time; Option C's gate overload fights the model. Option B is the only one that stays clean as the project grows.

---

## Consequences

**Positive**:
- The dashboard can render `awaiting_human_input` distinctly: artifact-production UI ("I'm done — review my design" button) rather than gate UI (advance/request-changes/reject buttons). Different verbs for different moments — partly addresses #62.
- `submit` becomes a forge primitive. When future workflows need human-produced artifacts (recorded interviews, hand-drawn diagrams, manual data exports), the same command applies with a different validator.
- `onReject` finally exercised in a real workflow (#25). When a human rejects a `review`, rationale flows back to the `brief` phase's prompt-author task as `inputs.rejectedRationale`.
- Reds compose later (#49) without further state-machine work — they hook the same post-blue-completion point that `submit` will trigger.

**Negative / Trade-offs**:
- Six task statuses to reason about instead of five. Every new spine-level helper has one more case. Tolerable; the new status has clean entry/exit conditions.
- `forge submit` is workflow-aware (it knows ui-design's `.pen` + PNG + HTML conventions). Either we centralize that knowledge in `submit.ts` (one validator function per manual-phase workflow) or we make it data-driven (workflow declares what files to validate). Start centralized; revisit if a third manual-phase workflow lands.
- The CLI grows by one command. Dashboard grows by one endpoint and one button.

**Risks**:
- Race between human-finishing-Pencil and `forge submit`: human hits submit before Cmd+S landed → `.pen` is 0 bytes → submit hard-errors. Acceptable; the error tells them what to fix and they re-submit. Not a silent failure.
- Human forgets to invoke `submit` and the run sits idle indefinitely. Mitigation: dashboard surfaces `awaiting_human_input` prominently; `forge advise` recommends `forge submit` for these tasks; `forge status` shows them. (No auto-detection — explicit signal beats polling.)
- `designDir` missing on a legacy run → submit hard-errors with "re-create the run with `--design-dir`." This is intentional; silent fallback would hide bugs. Captured in #66 (dashboard new-run modal must require designDir for these workflows).

---

## Implementation Notes

### State-machine semantics

| Status                   | Meaning                                                      | Entry                                       | Exit                                                      |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------- |
| `awaiting_human_input`   | Task is waiting for the human to produce artifacts off-forge | `next` advances to a phase with `agents: []`| `forge submit <task>` validates + transitions to `awaiting_gate` |

Transitions added:
- `pending` → `awaiting_human_input`: when `next` would normally dispatch a phase but the phase has no agents.
- `awaiting_human_input` → `awaiting_gate`: on successful `forge submit` (artifacts validated, paths captured into `task.result`).
- `awaiting_human_input` → (no other transitions). It does not crash, fail, auto-complete, or block-by-red. It only moves forward via explicit `submit`.

Note: `awaiting_human_input` does **not** participate in:
- Reconcile (no result.json to discover)
- Idle watchdog (no container running)
- `blocked_by_red` (no reds yet — that's where they'd attach when added)
- Auto-finalize on terminal phase (manual phases never auto-complete)

### Empty-agents phase recognition

In `createPhaseTasks` (src/spine/next.ts): if `phase.agents.length === 0`, create exactly one task with `agentRole = ""`, `agentAlias = undefined`, `agentModel = undefined`, `status = "awaiting_human_input"`. Skip the per-agent loop.

In `next.ts` itself: surface `awaiting_human_input` tasks the same way `awaiting_gate` is surfaced (return early, hint at the next command). New `NextResult` variant: `{ kind: "awaiting_human_input", tasks: Task[] }`.

In `dispatch.ts`: `dispatch()` is a no-op for empty-agents phases (the task was created in `awaiting_human_input` directly, never goes through dispatch). Defensive check: `dispatch` on a manual phase warns and returns `{spawned: 0, ...}`.

### `forge submit` command

```
forge submit <task-id> [--notes "<free text>"]
```

Behavior:
1. Load task. If status ≠ `awaiting_human_input`, hard-error.
2. Load run. If `run.metadata.designDir` missing for ui-design / design-revise workflows, hard-error with the message "this workflow requires `--design-dir` at run creation; re-create the run."
3. Workflow-specific validator runs (start with `validateUiDesignArtifacts(designDir, runTitle)`):
   - `<designDir>/<basename(designDir)>.pen` exists, size > 0. The `.pen` filename
     derives from the **last segment of designDir**, not the run title — that's the
     contract `seeds/agents/prompt-author/CLAUDE.md` writes into PROMPT.md, so the
     validator must agree. (Originally drafted as `<sanitized-title>.pen`; corrected
     during the smoke-test prep when the mismatch was caught — title is a human
     label, designDir basename is the cross-boundary contract. The runTitle
     parameter is retained as a fallback when basename is empty/`/`, an edge case
     that doesn't fire in real runs.)
   - `<designDir>/designs/*.png` matches at least one file
   - `<designDir>/code/*.html` matches at least one file
   - On any failure: hard-error naming the missing/empty path. Human re-runs Pencil or fixes the export, then re-submits.
4. Capture into `task.result`: `{ status: "complete", penFile, pngFiles: [...], htmlFiles: [...], notes? }`.
5. Transition task to `awaiting_gate`. Log event.

No mtime check in v1 (per Steven's call — fine to add later if stale-file confusion shows up).

### Reject loops to brief

`src/workflows/ui-design.ts`'s review phase declares `onReject: "brief"`. Existing `onReject` plumbing (commit `d075f9f`) already populates `inputs.rejectedRationale` and `inputs.rejectedTaskId` on the re-created brief task. Prompt-author's CLAUDE.md reads `inputs.rejectedRationale` if present and uses it to revise the brief.

### Dashboard surfacing

- `awaiting_human_input` task detail: render the brief-phase result inline (PROMPT.md body, parameters, openQuestions). Primary action button "I'm done — review my design" → POST `/api/submit/:taskId` (shells out to `forge submit` per FORGE-DEC-015). Secondary: "View artifacts on disk" link to `designDir`. Notes field → `--notes` flag.
- `awaiting_gate` task whose phase is the review phase: render PNG gallery (from `result.pngFiles`), `.pen` file path, HTML file links. Standard gate buttons (advance / request-changes / reject).
- Per-phase gate-button copy stays as #62; not in scope here.

### `forge advise`

Add a case for `awaiting_human_input` → recommend `forge submit <task-id>`. Otherwise unchanged.

### Tests to add

- `next.ts`: empty-agents phase creates one task in `awaiting_human_input`; subsequent `next` returns `awaiting_human_input` kind.
- `dispatch.ts`: dispatching a manual phase is a no-op.
- `submit.ts` (new): validates each artifact-existence rule independently; hard-errors on missing designDir; transitions task; populates result.
- `gate.ts`: gating an `awaiting_gate` review task with `reject` triggers `onReject` and creates a new brief task with `inputs.rejectedRationale`.
- `advise.ts`: recommends `forge submit` for `awaiting_human_input`.
- Dashboard: `/api/submit/:taskId` endpoint shells out to `bin/forge submit`; renders submit button only for `awaiting_human_input` tasks.

### Migration

The new status is additive — no existing rows need migration. `TaskStatus` is a TypeScript union (no DB enum), and `tasks.status` is `TEXT` in SQLite. Existing accessors (`getTask`, `tasksForRun`, etc.) need no schema change; only their callers that switch on status need a new branch.

---

## Revisit Conditions

- **A third manual-phase workflow lands.** Centralized validator switch is fine for two; at three, refactor to a data-driven approach where the workflow declares its own `manualPhaseValidator` function.
- **Reds attached to manual phases (per #49).** The submit step is already the right hook point for spawning reds against the human's output. Reuse the existing post-blue-task red plumbing — no further state-machine change.
- **Pencil ships auto-save** (per FORGE-DEC-014's revisit conditions). The `.pen` size > 0 check stays useful but the loud "Cmd+S" warning in PROMPT.md goes away.
- **Human-produced artifact validation needs to span more than file-existence** (e.g., PNG dimensions, HTML validity). Then the validator becomes a pluggable thing per workflow, not a hardcoded set of file checks.
