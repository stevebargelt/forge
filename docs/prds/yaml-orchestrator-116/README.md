# forge v2 — design drafts (BACKLOG #116)

This directory holds the design artifacts for forge v2: YAML-driven orchestrator
that replaces the TypeScript spine. The PRD itself is in the parent dir at
`../yaml-orchestrator-116.md`.

## What's here

| file | purpose |
|---|---|
| `SCHEMA.md` | The schema spec — what fields workflow + runtime YAMLs accept, and what they mean. Read this first. |
| `feature.yml.draft` | Translated from `src/workflows/feature.ts`. The reference workflow. |
| `feature-ui-design-provided.yml.draft` | Translated from `src/workflows/feature-ui-design-provided.ts`. |
| `feature-ui-design-needed.yml.draft` | Translated from `src/workflows/feature-ui-design-needed.ts`. Manual step + on_reject loop. |
| `investigation.yml.draft` | Translated from `src/workflows/investigation.ts`. **Uses fanout.** |
| `codebase-assessment.yml.draft` | Translated from `src/workflows/codebase-assessment.ts`. **Uses fanout.** |
| `ui-design.yml.draft` | Translated from `src/workflows/ui-design.ts`. Manual step. |
| `ui-design-revise.yml.draft` | Translated from `src/workflows/ui-design-revise.ts`. Manual step. |
| `runtime-claude-bedrock.yml.draft` | Translated runtime YAML for the bedrock provider. Pairs with feature.yml. |

## Session 2026-05-13 status

**Done:**
- Read Jeff's reference repo (`~/code/de-dev-adx-example-workspaces/jeffs-workspace-boilerplate/`) and Terry's (`~/code/local-adx-workspace-2/multi-agent-package/`).
- Confirmed Jeff's runner is purely linear; no parallel primitive in schema or executor.
- Confirmed Terry's runner is also linear, but the PM-emits-DAG vocabulary is in Terry's prompt templates (`requirements-to-work-packages.md`). Schema declares dependencies; runner walks linearly in topological order.
- Locked schema decisions: per-project override at `<project>/.forge/workflows/<name>.yml`, reds as list-of-dicts, step-level `gate: human|verdict|auto|none`, DAG via `depends_on`.
- Translated all seven existing workflows to YAML drafts. All seven fit the schema with no escape hatches.
- Discovered that **fanout is already in production use** (`investigation`, `codebase-assessment`) under the current TS type. Schema models it as `fanout.from_upstream`.
- Translated the claude-bedrock runtime to YAML.
- Wrote `SCHEMA.md` capturing all the field definitions and four open design questions.

**Open design questions (in SCHEMA.md):**
1. Is `fanout.from_upstream.step` always required, or is "previous step" implicit?
2. Does `workflow_additions` support template variable substitution?
3. What does `inputs.upstream[*]` mean in a DAG world — direct deps only, or transitive?
4. Should v2 enforce per-step result schemas via a `result_schema:` block?

**Next session:**
- Lock the four open questions.
- Write Zod schemas in `src/v2/schema.ts`.
- Write the runner: ~400-600 LoC topological walk + container spawn + SQLite writes.
- Wire `forge new` to the workflow's `inputs:` block.
- Translate the install layer (seeds → `~/.forge/agents/`).
- Delete the TS spine.

## Parallel concurrency in v2 — locked discussion

Question that nearly derailed the session: "if we adopt Jeff's linear shape, do
we lose the parallel reds that forge has today?"

**Answer: no, parallel reds are a separate primitive from DAG-fanout.** Reds
attach to a step and spawn in parallel after the step's primary agent completes.
This is a fixed `Promise.all(reds.map(spawn))` pattern, not a DAG walk. The
schema models it via the `reds:` block on a step — independent of `depends_on`.

**For DAG fanout-in-build (PRD says the planner emits `depends_on` + `discipline`
+ `files_modified` per step):**
- The *schema* supports it today (steps have `depends_on`).
- The *runner* will walk topologically with parallel-within-wave (`while
  readyQueue.size > 0 { Promise.all(readyQueue.map(spawn)) }`). ~30 LoC on top
  of linear.
- The *planner agent* doesn't emit DAGs yet — that's a v2.1 task (update the
  planner seed to emit `depends_on` on each step in its plan output).

So shape locked is: **DAG schema today, topological-with-parallel-wave runner
today, planner-emits-DAG in v2.1.** No regression from forge today, real path
forward.

## Why this isn't a forge run

(Recap from the PRD.) Three reasons we're doing this paired-Steven+Claude, not
through forge:

1. Forge v1 is the executor for forge v2's build — implementer mid-run editing
   the spine that's dispatching it is a real deadlock risk.
2. The hard work here is design (YAML schema shape, runtime resolution
   semantics, how phases-vs-steps reconciles), not implementation. Architect
   agent's value-add is weakest on already-thought-through design problems.
3. Step boundaries for a "rewrite the engine" task are themselves
   architectural decisions; the planner agent would produce *a* decomposition
   but probably not the right one.

Small translation tasks during the build (e.g., "translate `feature.ts` to YAML
matching the locked schema") may get farmed out once the schema is final.
