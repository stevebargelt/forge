# YAML-Driven Orchestrator (#116) — replace the TypeScript spine with declarative pipelines

## What this doc is

A design document for forge **v2**: rewrite forge's orchestration layer so workflows + agents + runtimes are declarative YAML files instead of TypeScript code. Keep forge's SQLite schema, dashboard, and gate UX unchanged. The result is the same forge from the dashboard's perspective — runs, tasks, verdicts, gates, reds, retries all behave as today — but the *control plane* underneath (workflow definitions, dispatch, spawn, agent registration) becomes data the human edits in YAML, not types the human compiles in TypeScript.

**Not running through forge.** This is a paired Steven+Claude design + build, not a feature-workflow run. Reasons (decided 2026-05-12):
- Forge v1 is the executor for forge v2's build — implementer mid-run editing the spine that's dispatching it is a real deadlock risk.
- The hard work here is design (YAML schema shape, runtime resolution semantics, how phases-vs-steps reconciles), not implementation. Architect agent's value-add is weakest on already-thought-through design problems; the PRD already captures the framing.
- Step boundaries for a "rewrite the engine" task are themselves architectural decisions; the planner agent would produce *a* decomposition but probably not the right one.

Treat this doc as the shared reference for the work, not a brief for agents. Small, well-scoped translation tasks (e.g., "translate `feature.ts` to YAML matching this schema") may get farmed out to agents during the build once the schema is locked.

## Why this matters

The "too complicated" feeling Steven has been carrying for weeks isn't a code-quality complaint — it's a structural one. Today, in forge:

- Adding a workflow phase requires editing a TypeScript `Workflow` object, often touching `composeSystemPrompt`, dispatch, and sometimes the SQLite schema.
- Adding a provider (OpenAI/Codex, BACKLOG #106) is open architectural work: `spawn.ts` hardcodes `claude` + `agent-dev-worker`; `creds.ts` hardcodes three Claude credential modes; the `AgentRef` type has no provider field.
- Adding a new agent role means a new directory under `seeds/agents/`, a `CLAUDE.md`, a `settings.json`, and (for typed wiring) sometimes new types in `src/types/index.ts`.
- Every primitive (`onReject`, `fanoutFromUpstream`, `RedConfig.additional`, the `discipline` tag on AgentRef) lives in the type system. Schema changes require migrations and broad TypeScript edits.

The control plane is doing too much. Jeff's workspace pattern (`pipeline.yml` + `runtime-*.yml` + per-project agent markdown) solves the same orchestration problem with ~400 lines of Python and zero typed schemas. The trade-off he accepts — no SQLite, no dashboard, no state machine — is real and not what we want. **The hybrid is: take Jeff's declarative shape, keep forge's SQLite + dashboard + gate logic.**

## Scope summary

**Big-bang migration.** New `system-map-105` branch... wait, no — this gets its own branch (`yaml-orchestrator-116`). At land time, the TypeScript spine code paths are gone; the YAML-driven runner is the only orchestrator. No feature flag, no dual-path.

**TypeScript runner.** Keep forge mono-language. Borrow Jeff's *shape* (YAML schema, executor structure), not his Python.

**YAML lives in two places with override semantics:**
- `~/.forge/workflows/<name>.yml` — workspace-default workflows (today's `feature`, `feature-ui-design-needed`, etc. translated to YAML)
- `<project>/.forge/pipeline.yml` (optional) — per-project override or extension
- `~/.forge/runtimes/<name>.yml` — runtime defs (`claude-bedrock`, `claude-oauth`, `claude-apikey`, future `codex-container`, `openai-container`)
- `~/.forge/agents/<role>/CLAUDE.md` + `settings.json` — workspace-default agents (today's `seeds/agents/<role>/` becomes the install target)
- `<project>/.forge/agents/<role>/` — per-project agent overrides (uncommon but supported)

**Last-one-wins:** project YAML overrides forge-home YAML by filename match.

## Run state at start (what exists today)

- 349 tests passing on the System Map branch (current work-in-progress; #105 is mid-implementation).
- SQLite schema with runs, tasks, verdicts, gates, events tables. All survive.
- Dashboard reads SQLite + renders pill row, task list, task detail, gate UX, System Map. All survive (the System Map work is in-flight; #116 starts after #105 lands and merges).
- TypeScript spine: `src/spine/{workflows,dispatch,spawn,spawnRed,next,gate,reconcile,composeSystemPrompt,constraints}.ts` — most of this gets deleted or replaced.
- Workflows: 7 TypeScript files under `src/workflows/` — translated to YAML.
- Agents: 15+ seeds under `seeds/agents/` — moved to `~/.forge/agents/` install target; structure preserved.
- Runtime detection: `src/util/creds.ts` (bedrock / oauth / apikey detection) — folded into `runtime-*.yml` selection.

## What's in scope (acceptance)

A working forge v2 where:

1. **Workflows are YAML.** `~/.forge/workflows/feature.yml` defines the feature workflow today's TypeScript does. Same phase shape, same gate semantics, same red configurations. Schema validated via Zod at load time; load failures surface useful errors.

2. **Per-project pipelines work.** A project at `~/code/<x>/` can declare `.forge/pipeline.yml` that overrides the workspace default. The runner picks the project pipeline when it exists, else falls back to `~/.forge/workflows/<workflow-name>.yml`.

3. **Runtimes are YAML.** `~/.forge/runtimes/claude-bedrock.yml`, `claude-oauth.yml`, `claude-apikey.yml` declare the docker invocation. `spawn.ts` reads the runtime YAML and builds the docker command from it instead of hardcoding mounts/env/entrypoint. Provider detection (which runtime to use) becomes a `runtime: claude` reference in the pipeline step, resolved via workspace defaults.

4. **Agents are markdown + JSON in well-known locations.** `~/.forge/agents/<role>/CLAUDE.md` (the prompt) and `settings.json` (tools allowlist). Pipeline YAML steps reference `task_file: <role>/CLAUDE.md` (or implicit by `agent: <role>` name). Today's `seeds/agents/` becomes the install source; running `forge install` lays them down at `~/.forge/agents/`.

5. **The new runner replaces dispatch + spawn + next + spawnRed.** A TypeScript `runner.ts` walks the pipeline steps, materializes handoff files in `/task`, spawns containers via the resolved runtime YAML, reads results, writes to SQLite. Same `runs / tasks / verdicts / gates / events` schema today. Forge's CLI commands (`forge next`, `forge gate`, `forge submit`, `forge dashboard`) continue to work unchanged from the user's perspective.

6. **Reds, retries, fanout, onReject — all preserved as YAML primitives.** `RedConfig` becomes a YAML sub-block. `fanoutFromUpstream` becomes a YAML field. `onReject` becomes a YAML field. Specialist red treatment per #113 is preserved (all reds in a `reds:` block inherit authority + gateOnVerdict).

7. **Gate logic stays as TypeScript** — verdict aggregation, force-advance-with-rationale, blocked_by_red status are correctness layers, not orchestration. Keep `src/spine/gate.ts` mostly intact; the runner *calls* gate.ts at gate decision points.

8. **Reconcile + transactional writes stay as TypeScript.** Orphan recovery, transactional task writes (#109), the `_setReconcileFaultForTest` hook — these are SQLite-state-machine concerns, independent of YAML vs TS for workflow definitions. Keep `src/spine/reconcile.ts` and the gate transaction work (#112 if landed by then).

9. **Auth mode detection** moves out of `creds.ts` into the runtime YAML: each runtime declares its credential mounts. The spine's "auto-detect bedrock from ~/.aws/config" stays as a pre-flight check that selects which runtime YAML to use as the default `runtime: claude` resolution.

10. **Dashboard unchanged.** Reads the same SQLite, renders the same pill row + task list + task detail + System Map. Zero code changes to `src/dashboard/*` (except possibly a startup load of which YAML pipeline a run is using, if we want to display it).

11. **All 349 existing tests pass.** Spine tests that test deleted code (dispatch.ts unit tests, spawn.ts argument-construction tests against the old shape) get deleted or rewritten against the YAML runner. The dashboard + gate.ts + reconcile.ts + store/* tests should pass unmodified — they're testing concerns that survive.

12. **`forge new` accepts both today's CLI flags and a `--pipeline <path>` for ad-hoc runs.** Today's `--brief`, `--prd`, `--design-dir`, `--question` flags continue to work. They become entries in `inputs.*` written into the task package, identical to today.

13. **DAG-driven fanout for implementation steps.** The planner emits a step DAG with `depends_on: string[]`, `discipline: 'frontend'|'backend'|'infosec'|'general'`, and `files_modified: string[]` per step. The runner reads the DAG and dispatches: steps with no unmet deps run in parallel; steps with deps wait for their parents to write `result.json`. Specialist routing happens via `discipline` (frontend → `frontend-implementer.md`, etc.) — workflow-level "this phase uses this agent" goes away for implementation phases. The runner verifies non-overlap of `files_modified` across parallel-dispatched steps and errors before spawn if two parallel steps share a file. This replaces v1's "build phase = one implementer container" model with "build = a DAG of specialist containers running as parallel as their dependencies allow."

## What's out of scope

- **Renaming forge.** This is forge v2, same name, same binary, same install path. The TypeScript runner replaces the TypeScript spine — same project.
- **Changing the SQLite schema.** Schema migrations are out of scope. The new runner writes to the existing tables. If a new column is genuinely needed (e.g., per-task `runtime_id` for audit), add it via the existing migration path; don't rebuild the schema.
- **Dashboard changes.** The dashboard reads SQLite; SQLite is unchanged. No `src/dashboard/*` edits beyond a possible "show which pipeline file a run is using" addition (which is itself follow-up scope).
- **Multi-provider support beyond claude-* runtimes.** The runtime YAML *makes* OpenAI/Codex easy, but writing the actual `runtime-codex-container.yml` is follow-up scope (#106 closes via the YAML mechanism but the actual codex runtime YAML lands as its own ticket).
- **System Map work (#105).** That's a separate in-flight ticket. #116 starts after #105 lands and merges. #116 inherits the System Map dashboard view unchanged.
- **Migrating in-flight runs.** Runs created on forge v1 don't need to keep running on forge v2. At cutover, complete or abandon in-flight runs; new runs are v2.
- **Backwards-compatible workflow loading.** The TypeScript `Workflow` type goes away. Anyone consuming it (none externally — forge isn't published) updates.
- **Changing how the dashboard, reconcile, or gate work.** Those are correctness layers and stay.

## Reference reading

Two working production references for the YAML-driven shape we're adopting. Read both before designing the schema.

**Jeff's workspace boilerplate** — `~/code/de-dev-adx-example-workspaces/jeffs-workspace-boilerplate/`
- `CLAUDE.md` — Jeff's full PM-driven flow + scaffolding rules
- `project_template/.workspace/pipeline.yml` — canonical pipeline.yml shape
- `.workspace-scaffold/scripts/orchestration/multi-agent/run-pipeline.py` — the executor (~400 lines Python; the shape we're translating to TS)
- `.workspace-scaffold/scripts/orchestration/multi-agent/workspace-defaults.yml` — default pipeline + global vars + runtime mapping

**local-adx-workspace-2** — `~/code/local-adx-workspace-2/multi-agent-package/multi-agent-framework/`
- `scripts/orchestration/multi-agent/runtime-claude-bedrock.yml` — canonical runtime YAML for the bedrock case
- `scripts/orchestration/multi-agent/runtime-codex-container.yml` — second runtime YAML showing how a different provider declares itself (relevant for #106 framing)
- `scripts/orchestration/multi-agent/framework/runner.py` — internal runner code (gate logic, context injection, result capture)

**Forge source to read** (what gets replaced vs what stays):
- `src/spine/dispatch.ts` — replaced
- `src/spine/spawn.ts` — replaced (docker invocation logic moves into runtime YAML evaluation)
- `src/spine/spawnRed.ts` — replaced (the launch-plan builder pattern from #113 carries forward in spirit)
- `src/spine/next.ts` — replaced
- `src/spine/composeSystemPrompt.ts` — folded into runner's prompt-composition step
- `src/spine/gate.ts` — **stays** (verdict aggregation, force-advance, rationale checks)
- `src/spine/reconcile.ts` — **stays** (orphan recovery, transactional writes)
- `src/spine/constraints.ts` — **stays** (file-based constraint loading + filtering)
- `src/workflows/*.ts` — 7 files translated to YAML
- `seeds/agents/` — agent seed structure relocates to `~/.forge/agents/` install target
- `src/types/index.ts` — Workflow / Phase / RedConfig / AgentRef types are the source for the YAML schema (probably reshaping AgentRef to fold in runtime + provider)

## Architectural angles worth thinking through

- **YAML schema design.** The schema must support every primitive forge has today (phases, gates, reds, fanout, fanoutFromUpstream, onReject, workflowAdditions, constraints) AND be ergonomic enough that the human edits it as a first-class authoring surface. Where does `RedConfig.authority` go in YAML? How is `fanoutFromUpstream`'s array-key destructuring expressed? Does `onReject` become a step-level field or a workflow-level field? These are the load-bearing schema decisions.

- **DAG-driven fanout, planner-emits-deps.** v2's implementation phase is a step DAG, not a static agent list. The planner's output for build is no longer `{steps: [{id, summary, files, acceptance}]}` but `{steps: [{id, summary, files_modified, acceptance, depends_on, discipline}]}`. The runner reads `depends_on`, executes the DAG topologically, parallelizing where deps allow. Three sub-decisions: (a) **Diff aggregation** — runner concatenates non-overlapping diffs, errors pre-spawn if two parallel steps share a `files_modified` entry. No orchestrator agent needed; the planner enforces non-overlap by being honest about file boundaries. (b) **Specialist routing** — `discipline` field on each step picks the implementer agent: `frontend → frontend-implementer.md`, `backend → backend-implementer.md`, `infosec → infosec-implementer.md`, `general → implementer.md` (the existing generic seed). Workflow-level "this phase uses agent X" goes away for build. (c) **Planner honesty constraint** — the planner seed gets explicit guidance: "your `files_modified` array is load-bearing; the runner uses it to detect parallel-write conflicts; understate at your peril." Replaces the v1 #96 vision (sub-shifts 3+4+5) entirely — fanout-in-build is v2's default model, not an opt-in primitive.

- **The `phases` vs `steps` vocabulary tension.** Jeff's steps are flat. Forge's phases group multiple agents under one gate. Pick one. Lean: **steps + gates** flat, like Jeff. A forge "phase" with multiple agents becomes multiple steps that share a gate (e.g., `gate_after: build_implement` says "gate after this step"). A phase with `gate: verdict` and fanout-of-N produces N tasks; YAML expression of fanout needs to be ergonomic.

- **Runtime resolution.** Today `creds.ts` auto-detects bedrock from `~/.aws/config`. Tomorrow each runtime YAML declares its detection: `requires_env: [CLAUDE_CODE_USE_BEDROCK]`, `requires_files: [~/.aws/config]`, or similar. Auto-detection becomes "scan available runtimes, pick first one whose `requires_*` clauses are satisfied." Or: `workspace-defaults.yml` declares which runtime claude maps to, and the human just runs the pipeline.

- **Workflow loading + override.** `~/.forge/workflows/feature.yml` is the default; `<project>/.forge/pipeline.yml` overrides. Override semantics: **full replacement.** Step-by-step merge is a maintenance trap (changes to workspace defaults silently affect projects that thought they were overriding only one step). If a project has its own pipeline, that pipeline IS the pipeline.

- **Agent loading + override.** Same shape: `~/.forge/agents/<role>/CLAUDE.md` is the default; `<project>/.forge/agents/<role>/CLAUDE.md` overrides. Full replacement of the agent dir (CLAUDE.md + settings.json together).

- **Gate integration.** When a pipeline step declares `gate: human` or `gate: verdict`, the runner stops, persists task state to SQLite, and exits. `forge next` re-enters and finds the awaiting_gate task. Force-advance, rationale, etc. all happen in gate.ts as today. The runner is mostly write-only; reading is the dashboard's job.

- **Reconcile compatibility.** Reconcile reads `tasks.taskPackage` from SQLite + `container.stdout.log` + `result.json` from disk. The runner must write the same shapes (TaskPackage stored as JSON in the row; stdout/result files in the per-task dir). Same audit trail, same recovery semantics.

- **Container lifecycle.** Today spawn.ts handles idle-watchdog, stream-json parsing, --include-partial-messages, the kill-by-container-name pattern, the `forge-test` wrapper for verify phase. All of this must survive the rewrite, compressed into a single "container exec" primitive that the runner calls per step with runtime YAML as input.

- **`composeSystemPrompt.ts` — what happens to it?** Today it composes the agent's CLAUDE.md + the workflow's `workflowAdditions` + force constraints into one system prompt. In YAML, this becomes: agent markdown + step's `workflow_additions` field (if present) + constraints lookup. The composition logic survives but its inputs come from YAML instead of typed objects.

- **Constraints.** Today `seeds/constraints/*.md` carries frontmatter declaring role/workflow/phase scope; `filterConstraints()` matches. In YAML world: same files, same frontmatter, same matching logic. The constraints surface doesn't need to change.

- **`inputs.upstream[*]` translation.** Today the runner derives upstream phase outputs and injects them into next-phase inputs. In YAML, this is `inject_context: true` per Jeff. Schema decision needed: what does "context" mean? All upstream tasks? The last one? Per-task selectable?

- **Migration testing.** Every existing forge run that landed (the #91 forge-on-forge run, the #105 System Map run, prior investigations) should be reproducible on v2 without dashboard or DB differences. What's the equivalence proof? Same task IDs? Same verdict counts? Same result JSON shapes? A reasonable answer: run a known v1 workflow under v2, compare SQLite state diff — should be functionally identical (modulo timestamps).

## Notes

- Paired Steven+Claude design + build, not a forge run. The reading list above is the shared reference; we work against the PRD directly.
- Big-bang means the work lands on a single branch (`yaml-orchestrator-116`) that **replaces** the spine. No flag, no dual-path, no slow migration. Test coverage must hold before merge.
- Forge v1 stays running until v2 merges. The System Map (#105) is in flight on its own branch and lands first; #116 starts after.
- Small, well-scoped translation tasks during the build (e.g., "translate `feature.ts` to YAML matching the locked schema") may get farmed out to agents once the YAML schema is finalized. The schema *design* is human + Claude work, not agent work.
