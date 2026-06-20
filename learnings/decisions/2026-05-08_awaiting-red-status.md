# Decision: `awaiting_red` task status

**ID**: FORGE-DEC-017
**Date**: 2026-05-08
**Status**: Decided
**Decided by**: Steven (after observing the bug in dashboard 2026-05-08)
**Supersedes**: N/A
**Scope**: forge

---

## Context

When a blue task with reds attached completes, today's flow is:

1. Blue's container exits → `spawn.ts` calls `markTaskComplete(task.id, ...)` → status becomes `complete`
2. `dispatch.ts` checks `phase.reds`; if reds are configured, calls `spawnRed()`
3. `spawnRed()` runs the reds (potentially several minutes), then transitions blue from `complete` → `awaiting_gate` (or `blocked_by_red`)

There's a real window between steps 1 and 3 where the blue task displays as `complete` (which the dashboard relabels "success") but it isn't *really* complete — reds haven't run yet, gate hasn't happened. With polling at 3s the user sees this state long enough to read it as "done." Then it flips to `awaiting_gate` which reads as a regression.

The polling-render bug (#72) made it more visible by smoothing flicker out, but the underlying confusion is structural: the same status `complete` is used for two distinct states ("blue done, reds running" vs "blue done, gate decided, fully resolved").

Steven's words 2026-05-08: *"'complete' is not true... it's awaiting red agents."* That's the right framing — the vocabulary is lying about what's happening.

This is a state-machine change. Per CLAUDE.md, state-machine status additions need an ADR.

---

## Problem

How does forge represent the state "blue task finished, reds in flight" honestly — distinct from both `running` (blue is still working) and `complete` (gate has happened, work is fully resolved)?

---

## Options Considered

### Option A: Status quo — overload `complete`

Keep using `complete` for "blue done, reds running" AND for "fully resolved." Disambiguate in the dashboard by checking whether a gate row exists for the task.

**Pros**:
- Zero state-machine change.
- Existing reconcile / advise / gate code paths unchanged.

**Cons**:
- Lies in the vocabulary — `complete` means two things. Dashboard logic has to inspect gate history per-task to render correctly. Spillover bug surface.
- The audit trail for runs is muddled: log/event readers can't tell "blue done" from "fully resolved" without joining gates.
- Stays out of step with `awaiting_human_input` (FORGE-DEC-016) — that one chose to add a status for an analogous "in flight, not yet resolved" state. Same pattern, different decisions makes the state machine harder to reason about. (Note: `awaiting_human_input` has since been removed — it was never wired up and nothing ever produced it. See FORGE-DEC-020.)

---

### Option B: New `awaiting_red` status ✅

Add `awaiting_red` to the `TaskStatus` union. After spawn() returns successfully, `dispatch.ts` immediately transitions the blue from whatever spawn left it as → `awaiting_red` if the phase has reds, before awaiting `spawnRed()`. `spawnRed()` then transitions out of `awaiting_red` → `awaiting_gate` / `blocked_by_red` exactly as it does today.

**Pros**:
- Honest vocabulary: each status names exactly one state.
- Dashboard renders `awaiting_red` distinctly without inspecting other tables.
- Audit trail is self-explanatory in events / queries / logs.
- Symmetric with FORGE-DEC-016's `awaiting_human_input` — same pattern (production states get their own name, decision states get their own name).
- Composes cleanly with smart-refresh (#72) — status changes drive render keys; no need for downstream cross-table queries.

**Cons**:
- One more status (7 total after FORGE-DEC-020 removed `awaiting_human_input`: pending, running, awaiting_gate, awaiting_red, complete, failed, blocked_by_red). Every code path that switches on status gets one more case.
- Requires placement decision: where does dispatch.ts set it? (See Implementation Notes.)

---

### Option C: Move blue's `markTaskComplete` out of spawn() entirely

spawn() returns the result without persisting status; dispatch.ts owns all blue lifecycle transitions. Then there's no "complete-then-overwrite" window even microscopically.

**Pros**:
- Architecturally cleanest. spawn() becomes a pure "run the container, return the result" function.
- No transient `complete` state ever exists — blue goes `running` → `awaiting_red` directly when reds are configured.

**Cons**:
- Bigger refactor of the spawn/dispatch boundary. Touches reconcile too (which today reads spawn's persisted state).
- The microsecond `complete` window in B is invisible in practice (polling can't catch it).

---

## Decision

**Chose**: Option B — add `awaiting_red`, dispatch.ts overwrites just-after-spawn-completes.

Option C is the cleaner long-term shape but a bigger refactor. The pragmatic choice (B) gets the user-facing honesty fix without disturbing the spawn/reconcile contract. Capture C as a follow-up cleanup; ship B now.

Decided 2026-05-08 with Steven: *"Yes note those"* (referring to the microsecond window of `complete` being acceptable as the pragmatic placement).

---

## Consequences

**Positive**:
- Dashboard renders the truth: "this blue is done, reds are still running" is its own visible state, distinct from "fully resolved."
- Vocabulary aligns: `awaiting_*` is now the prefix for all "in flight, not yet decided" states (gate, human input, red).
- `forge advise` can recommend "wait for reds to finish" as a distinct action (informational; nothing for the human to do, but clearer than "running").
- Future smart-refresh hashes naturally include the new state; no special-casing needed.

**Negative / Trade-offs**:
- Eight statuses instead of seven. Code paths that switch on status: dispatch.ts, gate.ts, advise.ts, reconcile.ts, store/tasks.ts, dashboard/html.ts, cli/commands/next.ts, cli/commands/status.ts. Each adds one arm.
- Tests across spine + dashboard need new-status coverage.

**Risks**:
- A blue with reds that fails (spawn returns `status: "failed"`) should NOT enter `awaiting_red` — it should go to `failed`. Already handled by dispatch.ts:100-102 (returns early on failed). Verified.
- Reconcile must NOT touch `awaiting_red` tasks (they're not orphaned; reds are running). Today's reconcile only touches `running`, so this is naturally correct, but worth a defensive comment.

---

## Implementation Notes

### Where to set `awaiting_red`

In `dispatch.ts`'s `runBlueTask`, between spawn returning successfully and the spawnRed call. The relevant code today:

```ts
const refreshed = getTask(task.id);
if (!refreshed) return { taskId: task.id, status: "failed" };

if (phase.reds && (phase.reds.wide || phase.reds.narrow)) {
  await spawnRed({ ... });
}
```

Insert before the `await spawnRed`:

```ts
if (phase.reds && (phase.reds.wide || phase.reds.narrow)) {
  setTaskStatus(task.id, "awaiting_red");
  logEvent("task.awaiting_red", { runId: run.id, taskId: task.id });
  await spawnRed({ ... });
}
```

`spawnRed` ends by transitioning to `awaiting_gate` / `blocked_by_red` — that overwrites `awaiting_red` correctly.

### What `spawn.ts` does

Stays the same. It still calls `markTaskComplete` (or `markTaskFailed`) per its existing contract. The microsecond window of `complete` between markTaskComplete and dispatch's overwrite is invisible in practice — Option C closes it permanently if needed later.

### Reconcile

No code change required. Today's reconcile filters `tasks.status === "running"` only; it ignores `awaiting_red` automatically. Add a one-line comment clarifying the new status is also intentionally ignored (red tasks are siblings; if they crash, the parent stays in `awaiting_red` and the human eventually notices). The eventual proper fix is for spawnRed-completion to recover from a crashed red the same way reconcile does for blues — separate task.

### Reds that themselves crash

If a red task crashes mid-run, the blue stays in `awaiting_red` indefinitely. This is a real gap (similar in shape to #74, the zero-stdout orphan bug). Track as a separate follow-up; the new status doesn't make it worse, just more visible.

### Dashboard render

`awaiting_red` gets its own status badge tone. In #72's render-key, status is already a primary input — no cache-key changes needed.

### `forge advise`

New arm: when `counts.awaiting_red > 0`, recommend "wait for reds; check the dashboard." Not actionable; informational.

### Test surface

- dispatch.ts test: blue with reds transitions running → complete (briefly) → awaiting_red → awaiting_gate/blocked_by_red.
- dispatch.ts test: blue without reds transitions running → complete → awaiting_gate (no awaiting_red visit).
- advise.ts test: awaiting_red counts ranked appropriately.
- next.ts test: `kind: "awaiting_red"` returned when applicable; users informed but no action recommended.

---

## Revisit Conditions

- **Reds that crash leave blue in awaiting_red forever.** When this becomes a real friction (probably soon), add reconcile handling for awaiting_red blues whose red children are gone. Separate task.
- **The microsecond `complete` window starts mattering.** If a future feature observes that window (e.g., a webhook fires on `complete` events and we don't want it firing for "transient complete"), promote to Option C — refactor spawn/dispatch boundary.
- **A workflow appears where reds run on a phase that's NOT a blue task (e.g., reds on a gate, or reds on a manual-phase result).** Then `awaiting_red` semantics need to be revisited — is the wait state on the manual-phase task? Today's manual phases (`ui-design.review`) have `reds: undefined` so this doesn't apply yet. #51 (design-reviewer) might change this.
