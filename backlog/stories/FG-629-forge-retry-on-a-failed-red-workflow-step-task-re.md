---
id: FG-629
type: story
status: active
title: forge retry on a failed RED workflow-step task re-dispatches the STEP PRIMARY under the red's role, producing a duplicate primary artifact and a fresh red wave
created: 2026-07-27
---

**Found live 2026-07-27** while recovering the FG-566 architect phase
(`run-fg-566-shared-host-side-verification-readiness-contract-0f7edc`) from the FG-628 red container
crash.

## What happens

Two architect reds had failed with `container_crash` (FG-628). The obvious recovery — re-run the
reds so the artifact actually gets adversarial review — was:

```
forge retry task-red-architect-da8b83     # red-wide
forge retry task-red-architect-82a680     # red-narrow
forge next <runId>
```

`forge retry` reset each red to `pending` with a **new task id**, and `forge next` then dispatched
one of them. But what ran was **not a red**. `task-architect-8837cb` was created with:

- `phase: architect`
- `agentRole: red-wide`
- a task package carrying the **architect step's primary prompt**, not the red review prompt

It ran for 11 minutes and produced an **architect-shaped result** — keys `sharedPrimitive`,
`decomposition`, `readinessBinding`, `fencedOut`, `changeShape`, `risks`, `boundaries` — with no
`verdict`, no `confidence`, and no `findings`. It is a second, independent architect artifact wearing
a red-wide label.

Forge then treated that task as a step primary in its own right: on completion it went
`task.awaiting_red` and **dispatched a fresh red wave against it** (`task-red-architect-b266d3`
red-wide, `task-red-architect-ba534b` red-narrow). Those two ran correctly and returned real verdicts
— red-wide `fail` 0.91, red-narrow `pass` 0.92 — but they reviewed *the duplicate artifact*, not the
canonical one.

Net effect from two retry calls:

- 1 duplicate primary artifact (`task-architect-8837cb`) that had to be `--force`-gated out of the way
- 1 extra red wave (2 containers, ~3 min)
- 1 further pending duplicate (`task-architect-c66501`, from the red-narrow retry) that would have
  produced a **third** architect artifact on the next `forge next`, and had to be `forge cancel`ed
- the canonical artifact `task-architect-492a16` still carrying its two non-blocking
  `inconclusive (0.00)` verdicts from the original crash — i.e. **the thing the retry was for never
  happened**

## Why it matters

The retry is silently the wrong operation rather than a refused one. An orchestrator recovering a
crashed red reasonably expects `forge retry` to re-run *that red*; instead it spends a full primary
agent turn, corrupts the phase topology with competing primaries, and leaves the original artifact
still unreviewed. The failure is expensive and non-obvious — it only shows up when you inspect the
retried task's `result` keys and notice they are not a Verdict.

This compounds the known gap that there is **no in-phase red re-review path** for a workflow step.

## Acceptance criteria

1. Reproduce RED: retrying a failed red workflow-step task currently re-dispatches the step primary.
   Assert against the observed shape — the retried task's result is the primary's payload, not a
   Verdict, and a fresh red wave is dispatched against it.
2. Retrying a failed RED re-runs **that red against the original primary's artifact**, and does not
   create or re-run a primary. The re-run red's verdict attaches to the original primary task
   (`task-architect-492a16`-equivalent), replacing or superseding the crashed red's ingested verdict.
3. A retried red does **not** trigger a new red wave — reds are not themselves subject to review.
4. If per-red re-dispatch genuinely cannot be supported for workflow steps, `forge retry` must
   **refuse** on a red task with a message naming the supported recovery, rather than silently
   re-running the primary. A refusal is an acceptable resolution; the current silent substitution is
   not.
5. Whatever the resolution, the crashed-red case must end with the primary's verdict set actually
   reflecting a real review — not left at the non-blocking `inconclusive (0.00)` the crash produced
   (this is the FG-628 ingestion half; the two tickets meet here).
6. `forge-test` green; required CI checks green.

## Recovery actually used (for reference)

Gated the canonical artifact `task-architect-492a16` on its merits with the duplicate's red findings
dispositioned in the rationale (they applied equally, the proposals being substantively the same);
`--force`-advanced the duplicate `task-architect-8837cb` with a rationale recording its provenance;
`forge cancel`ed the pending `task-architect-c66501`. Workable, but entirely manual and dependent on
noticing the result-shape anomaly.

Refs: FG-628 (the red container crash that prompted the retry, and the `inconclusive` ingestion of a
never-started red), `src/cli/commands/retry.ts`, `src/v2/runNext.ts` dispatch/fanout lineage, and the
`runNext.ts:691` unsubstantiated-fail downgrade already recorded as adjacent behavior.
