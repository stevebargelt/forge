---
id: FG-96
type: story
status: done
title: "Build-phase decomposition: implementer fanout + orchestrator + planner-emits-deps"
---

**Closed:** 2026-05-23. Commit `post-v2-runner-with-fanout`.

**Sub-shifts 3+4+5 absorbed by #116** (2026-05-13). Forge v2 makes DAG-driven implementation fanout the default model, not an opt-in primitive — planner emits `depends_on` + `discipline` + `files_modified`, runner parallelizes via the DAG, routes per discipline. The sub-shifts below are the v1 framing; if v1 ships them before #116, they're still valuable. If #116 lands first, the v2 implementation makes sub-shifts 3+4+5 moot. Sub-shifts 1+2 (specialist red + implementer seeds, shipped 2026-05-09) survive in both worlds.

**Why:** Today the `build` phase is a monolith — one `implementer` agent reads the plan, edits the codebase serially, produces one diff. That works for tasks small enough to fit in one agent's head, but it doesn't scale: parallel-safe steps run sequentially, the diff balloons until reds can barely review it, and there's no specialization (a frontend feature, a backend migration, and a security hardening pass all route through the same generic seed). Composite of multiple architectural shifts that share a lens — *the build phase needs to decompose into specialized fanout + coordination, the way other multi-phase forge primitives already work*.

The shift has four sub-shifts. **#92 architect-scope rewrite (closed) is the precedent**: same shape — agent role definition matters more than prompt tweaking. **#73 reds-as-reviewer (open)** is also adjacent — both are "the agent has the wrong job description, not just a wrong prompt."

**Sub-shift 1: specialist reds.** *Shipped tonight (foundation).* Three new red seeds (`red-frontend`, `red-backend`, `red-security`) with `gateOnVerdict: false` (informational, doesn't block) attached automatically to the `build` phase across `feature*` workflows alongside the existing `red-wide`/`red-narrow` authoritative reds. RedConfig extended with optional `additional?: AgentRef[]` to support arbitrary specialist reds. Each specialist reviews through its discipline's lens (a11y, transactions, secrets/auth/CSP). This sub-shift unblocks the others — the implementer-fanout and orchestrator can build on a working specialist-red layer.

**Sub-shift 2: specialist implementers.** *Shipped tonight (foundation).* Three new implementer seeds (`frontend-implementer`, `backend-implementer`, `infosec-implementer`) with discipline-specific framing. Original `implementer` stays as the generic fallback for ambiguous work. AgentRef gains optional `discipline?: "frontend" | "backend" | "infosec"` field. **Not yet wired into workflows.** Workflows still use the generic `implementer` for `build`. The seeds exist; the routing decision is part of sub-shift 3.

**Sub-shift 3: implementer fanout.** *Architecturally open.* The `build` phase fans out per plan-step, one specialized implementer container per step, running in parallel where steps are independent. **Hard parts:**
- **Planner emits a dependency graph.** Today the planner outputs `steps: [{id, summary, files, acceptance}]` — flat. For fanout to work, the planner needs to add `dependsOn: string[]` (other step ids) AND `discipline: "frontend" | "backend" | "infosec" | "general"`. Steps with deps wait for their parents. Steps without deps fan out in parallel. Steps without a discipline route to generic `implementer`.
- **Merge conflicts.** Multiple containers writing to the project at the same time is mechanically supported (each container has rw mount), but only safe if the planner correctly identifies file-level independence. Planner has to be honest about what files each step touches. False-negative independence (claiming two steps don't touch the same file when they do) → race condition between containers. The planner's job gets harder; planner seed needs to acknowledge this constraint.
- **Failure semantics.** Existing `fanout.failureMode` field has options (`fail-phase` | `retry-once` | `continue`). Lean `retry-once` for code-build fanout — transient failures get a chance to recover; persistent failures eventually fail-phase. **Continue is dangerous** for code (broken state); fail-phase is too brittle (one flaky red kills the run).
- **Atomicity of "build is done."** Today `build` produces one diff_summary. With fanout, each task produces its own. The synthesis happens... where? Three options worth weighing: (a) a new `merge` phase between `build` and `verify` that reconciles per-task diffs; (b) `build`'s gate-phase aggregates all sub-task results before advancing; (c) accept N diffs and let `verify` check them all together. Lean (a) — the orchestrator (sub-shift 4) is the natural home for this; merge becomes its visible output.

**Sub-shift 4: orchestrator role.** *Architecturally open.* A coordinator agent that lives inside the `build` phase, runs concurrently with the implementer fanout, and handles the gaps-between-containers that mechanical fanout can't. **What only an orchestrator can contribute:**
- **Pre-flight validation.** Receives the planner's step graph, validates feasibility, surfaces planner mistakes ("steps 3 and 7 both modify the same file but aren't marked as dependent — that's a planning bug").
- **In-flight monitoring.** Watches each implementer's progress. Detects stuck containers (no stdout, no result.json after N minutes — see #74). Detects drift (implementer A finished and changed a file that implementer B's plan assumed was static).
- **Conflict resolution.** When two implementers' file changes overlap, decides merge order, possibly re-plans one of them with the other's diff as input.
- **Finalization.** When all sub-tasks complete (or fail), produces the *aggregate* result that gate.ts reviews — diffs combined, failures surfaced, conflicts noted.

**Where the orchestrator lives in the workflow shape — three options:**
- **(a) Orchestrator-as-phase.** New `orchestrate` phase between `plan` and `build`. Reads the plan, decides parallelism, spawns implementer fanout, monitors, finalizes. The phase doesn't end until every implementer is done. *Cleanest workflow-shape-wise but a new primitive — current phases produce a result and exit; an orchestrator phase persists for fanout duration.*
- **(b) Orchestrator-as-meta-agent within `build`.** `build` has fanout=true plus an orchestrator container running in parallel that watches the fanouts. Two agents per phase; new mental model. *Lean (b) — coordinator is genuinely an agent role with judgment, not spine glue. Modeling it as a peer agent within the phase keeps workflow vocabulary clean.*
- **(c) Orchestrator-as-spine-extension.** Build orchestration into the spine itself, no agent. Mechanical-but-smarter. No coordinator-tokens cost. *Limits orchestration to what spine code can pre-program; loses agent's flexibility for novel situations.*

The decision between (a)/(b)/(c) defers to actual fanout-implementer behavior — needs experimental data.

**Why this matters and earns its tokens:**
- Today's "one implementer reads the plan, edits the codebase, produces a diff" works only for tasks that fit in one head. Forge has shipped that scale; the next scale is multi-step features where each step is its own concern.
- The build phase is the bottleneck for any non-trivial feature. Decomposition moves the bottleneck out.
- Specialization composes with fanout: specialist reds review per-step, specialist implementers handle per-discipline work, orchestrator coordinates. Each layer earns its place because the alternative (one generic agent reviewing/writing/coordinating everything) is forge's #92 architecture-tutoring failure mode at scale.
- `red-wide` and `red-narrow` are *probably* due for retirement once specialists are proven, but tonight's wiring keeps them alongside specialists rather than replacing — additive, reversible.

**How to apply (in order, sized for incremental shipment):**
1. *(Tonight, Tier 1.)* Specialist red seeds + specialist implementer seeds + RedConfig.additional + AgentRef.discipline. Workflows wire specialists to build phase, gateOnVerdict: false, parallel: true. Tests confirm registration. **No fanout yet.** Foundation only.
2. *(Future.)* Update planner seed to emit `dependsOn` + `discipline` per step. Existing build phase still runs serially; planner's new fields are additive metadata.
3. *(Future.)* Convert build phase to fanoutFromUpstream on `steps`. New phase shape that fans out per-step into specialized implementers based on discipline. Failure mode: retry-once. Use existing fanout machinery; specialists earn their places per-task instead of per-phase.
4. *(Future.)* Add orchestrator role. Decide (a)/(b)/(c) shape based on what step 3 reveals. Wire into build phase per chosen shape.
5. *(Future, optional.)* Add `merge` phase between `build` and `verify` if step 4's orchestrator produces aggregate output that needs its own gate.

**Composite with #73 (reds-as-reviewer):** both #73 and #96 are "one agent role doesn't earn its tokens because it's doing too much" — #73's reds were reviewing the underlying subject instead of the work-product (vocabulary mismatch); #96's implementer is one generic agent doing every discipline (specialization mismatch). Same lens: define each agent's role by what *only it* can contribute, then split when the lens reveals one agent is doing two jobs.

**Sequencing:** sub-shifts 1+2 ship tonight as foundation. 3+4+5 are daytime architectural conversations + experimental data + structured decisions. Each sub-shift is testable in isolation and reversible.

**Stretch goal worth flagging:** "skip architect" workflow flag. Some feature work (cheap features, refactors, isolated additions) doesn't need an architect phase. Today the workflow shape is fixed; turning architect off requires a new workflow file. Better: a workflow-level flag `phases.skipIf: <condition>`. Defer; architectural framing only.