---
id: FG-584
type: story
status: active
title: feature build fanout cannot express semantic dependencies between plan steps — file-disjoint is not the same as independently typecheckable
created: 2026-07-17
---

**Surfaced by:** FG-577's plan gate, 2026-07-17 (run
`run-fg-577-install-path-resolves-release-owned-assets-from-the-executing-release-aa4226`, `task-plan-70b744`).
The tech-lead diagnosed this itself and escalated rather than hiding it — the plan was correct and simply not
dispatchable.

## The gap

`seeds/workflows/feature.yml`'s build phase fans out one child per plan-step with `max_concurrency: 4` and
**no inter-step ordering**. Its `workflow_additions` assert only:

> "The tech-lead asserts your step's files are independent of every other step's files in this build"

**File-disjointness is necessary but NOT sufficient.** Steps must also be **independently typecheckable**. A
plan whose step 1 creates a new module and whose steps 2..n import it has strictly disjoint `files` lists and
still cannot be dispatched: children run in parallel containers, so steps 2..n typecheck against a module that
does not exist in their worktree.

The plan phase has no vocabulary to express a semantic dependency, and the runner has no `depends_on` between
fanout children. So a tech-lead that correctly identifies "step 1 must land before steps 2-5" is describing a
guarantee the runner cannot provide, and the orchestrator must hand-collapse the plan at the gate via
`request-changes` — costing a full replan round.

Verbatim from `task-plan-70b744`'s notes:

> "ORDERING IS LOAD-BEARING AND IS NOT THE SAME AS FILE-INDEPENDENCE. The `files` lists are strictly disjoint
> — verified by grep over /project; no path appears in two steps — so there is no working-tree race. But steps
> 2, 3 and 4 IMPORT the module step 1 creates (src/v2/asset-root.ts), and step 5 asserts over all four. If the
> build phase dispatches all five in parallel containers, steps 2-5 will fail their own typecheck because
> asset-root.ts will not exist in their tree. Step 1 must land and merge before 2-4 dispatch; step 5 after
> those. I did not merge them into one step because that would collapse the entire ticket into a single
> container and forfeit the per-step acceptance criteria the audit demands — the dependency is semantic, not a
> file conflict, and is the correct thing to sequence rather than to dissolve."

## Why it recurs

This is not a one-off. **Any** plan that introduces a new primitive and routes existing call sites through it —
a very common and *desirable* refactor shape — has this structure. The current workaround (collapse to one
step) is correct but forfeits fanout entirely for exactly the changes that most benefit from decomposition, and
it is only reachable if the orchestrator catches it at the plan gate. If the orchestrator advances, the build
fails N-1 children with confusing isolated-typecheck errors and `failure_mode: fail-phase` takes the phase down.

## Options (not yet decided — needs a design pass)

1. **Waves.** Let a plan step declare `depends_on: [stepId]`; the runner dispatches in topological waves, each
   wave merging before the next dispatches. Most expressive; largest change; interacts with FG-478's
   re-expansion semantics and with the parent's red aggregation.
2. **Teach the tech-lead the constraint.** Encode "steps must be independently typecheckable, not merely
   file-disjoint; cohesive primitive-introduction is ONE step" into the plan-phase `workflow_additions` and the
   tech-lead seed. Cheapest; makes the current hand-collapse automatic instead of a gate catch. Does not
   recover fanout for these changes.
3. **Validate at the gate.** Statically reject a plan whose steps import each other's new files, so the failure
   is named at plan time rather than as N-1 confusing typecheck errors at build time.

(2) and (3) are complementary and cheap; (1) is the real fix and should not be attempted without an
architecture pass. Note the campaign lesson: elaborate machinery signals a wrong architecture — ask whether the
invariant can MOVE (e.g. the plan simply must not emit interdependent steps) before building a wave scheduler.

## Acceptance
- A plan with interdependent steps is either dispatched correctly (waves) or **refused with a named,
  actionable error at plan time** — never dispatched into N-1 isolated typecheck failures.
- Whichever option: a regression test observed RED against the current runner using a two-step plan where step
  2 imports a module step 1 creates.