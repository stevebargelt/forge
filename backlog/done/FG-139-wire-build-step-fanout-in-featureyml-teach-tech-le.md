---
id: FG-139
type: story
status: done
title: Wire build-step fanout in feature.yml + teach tech-lead to emit depends_on per plan-step
---

**Closed:** 2026-05-25. Commit `63b9f61`.

**Why:** The v2 runner has full fanout machinery (see src/v2/runNext.ts dispatchFanoutStep + runFanoutChild — DAG-driven, max_concurrency, failure_mode, per-discipline routing). But the actual feature workflow doesn't use it: \`seeds/workflows/feature.yml\` build step is a single \`engineer\` invocation, no \`fanout:\` block. The infrastructure shipped (closed #96 sub-shifts 3+4+5 absorbed by #116) but the workflow-level wiring + planner support never landed.

**Two-part fix:**

1. **Tech-lead seed update.** Today the planner outputs flat \`steps: [{id, summary, files, acceptance}]\`. For fanout the planner needs to add:
   - \`depends_on: string[]\` (other step ids this step blocks on)
   - \`discipline: "frontend" | "backend" | "infosec" | "platform" | "general"\` (which specialist routes the step)
   - \`files_modified\` must be honest at planning time — multiple containers writing to overlapping files is a race condition the runner can't catch
   
   Updated seed needs an example of dependency-graph shape + a load-bearing note that lying about \`files_modified\` independence breaks the world.

2. **feature.yml build step.** Add a \`fanout:\` block reading the tech-lead's \`steps\` array. Each plan-step becomes one fanout child task. Specialist routing via the discipline field — the runner needs to honor it (today \`dispatchFanoutStep\` calls \`runFanoutChild\` which uses \`step.agent\` from the workflow YAML — needs to be teachable that the discipline value picks the agent per child).

**Open question on shape:** the runner's current fanout assumes one agent per fanout step (you fan one agent across N items). Discipline-driven routing is different — different agents per child based on the child's data. That might need a small runner change (\`fanout.agent_from_input\` or similar). Worth a design pass before just wiring.

**Why this matters:** today the feature workflow's build phase is serial through one engineer agent. Multi-discipline features (frontend + backend + infra in one feature) all funnel through generic engineer, losing the specialist seeds we built. Wiring fanout makes the specialists earn their tokens.

**Sized as:** medium. Tech-lead seed update is small; feature.yml is small; the runner change for discipline-routed fanout is the real work.

**Composite with:** the v2 cutover (#116, closed). This is the unfinished tail.

**Caught:** 2026-05-23 — during quick-fix backlog triage; #96's deeper goal (build-phase decomposition) didn't fully land with v2.