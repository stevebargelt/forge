---
id: FG-116
type: story
status: done
title: "Forge v2: YAML-driven orchestrator (cutover complete)"
---

**Closed:** 2026-05-14. Merge commit `b818f27` on `main` (the `yaml-orchestrator-116` branch merge). 23 commits on the branch; net `+1,113 / -6,228` LoC. 279/279 tests passing.

**What landed:**
- **v2 runner core**: schema (Zod) + YAML loader + ready-queue + DAG dispatcher (`src/v2/{schema,loader,ready-queue,inputs,runNext}.ts`). Wave-per-call shape; orchestrator calls `runNext` in a loop. Parallel-within-wave via `Promise.all`.
- **Reds + fanout in the runner**: reds spawn as child tasks after primary completes, verdicts persisted, authoritative-fail blocks via `blocked_by_red`; fanout reads upstream array, spawns N children with `max_concurrency`, applies failure_mode (`fail-phase` / `retry-once` / `continue`).
- **v2 gate**: `src/v2/gate.ts` — marks complete/fail; for reject + on_reject inserts pending in the on_reject step; for request-changes inserts pending in same step. Runner picks up successors via ready-queue (no proactive task creation).
- **`forge invoke`**: single-agent dispatch primitive (`src/v2/invoke.ts`, `src/cli/commands/invoke.ts`). The RACI orchestrator's bread-and-butter. Synchronous; returns when the agent completes.
- **RACI seed** (`seeds/forge-raci.md`): 11 work types, R+A+C+I rows, Path = in-session / invoke / pipeline. Implementation routes through pipeline; everything else through invoke.
- **Orchestrator template** (`seeds/orchestrator-template.md`) rewritten RACI-first: classify prompt → look up RACI → route. Multi-agent composition via chained `forge invoke` in the conversation, not a workflow file.
- **CLI cutover**: `forge new`/`next`/`gate` route to v2. `forge invoke` / `forge upgrade` / `forge init` / `forge watch` added.
- **3 workflow YAMLs**: `feature`, `feature-ui-design-needed`, `feature-ui-design-provided` in `seeds/workflows/`.
- **3 runtime YAMLs**: `claude-bedrock`, `claude-oauth`, `claude-apikey` with `detect` blocks. `runtime: claude` (schema default) auto-resolves via env at spawn time.
- **First real forge v2 run end-to-end** (`run-smoke-v3-491805`): architect → plan → build (engineer + 5 reds parallel) → verify, producing the `forge --version` flag diff committed as `51a3c64`.

**Deletions:**
- `src/spine/` (13 modules) + `src/workflows/` (8 v1 workflows + tests). v1 is gone.
- `forge submit` + submitValidators — ui-design is host-led under RACI; no manual phase needed.
- `reconcile` — orphaned-task safety net; v2 doesn't have one. `forge retry` is the manual escape.
- v1 types: `WorkflowName`, `Workflow`, `Phase`, `AgentRef`, `RedConfig`, `FanoutConfig`.
- Dashboard: 4 obsolete workflow options (investigation, codebase-assessment, ui-design, ui-design-revise) + `/api/submit` endpoint.

**Bugs caught + fixed during smoke testing:**
- `TASK_PACKAGE_MARKDOWN` was missing from `SpawnContext` (runtime YAML expected it via `${TASK_PACKAGE_MARKDOWN}` template).
- Bedrock Haiku model ID was missing the `-v1:0` suffix in `claude-bedrock.yml`.
- Run metadata (`brief`, `question`, `prd`) wasn't being folded into the first task's inputs.

**Model mapping (was inverted at one point during the day):**
- Bedrock `spec-writer` → Sonnet 4.6 (work account; Opus restricted).
- OAuth `spec-writer` → Opus 4.7 (personal Pro account).
- Both `fast-orchestrator` → Haiku 4.5.

**Honest flags:**
- **Reconcile is gone.** If a container produces result.json but Node loses the docker-close event, the task sits in `running` forever. Use `forge retry <id>`. File a v2 reconcile back if the bug shows up.
- **Dashboard pill row stubbed** — tracked as #136. Run page still works (task table fine; no pills).
- **Reds reviewed the wrong artifact on `run-smoke-v3-491805`** — tracked as #135. Architecture is right (red gets primary's result.json as artifact); seed needs to make the red consult `files_modified` + `git diff` rather than the engineer's summary text.

**Composes with:** closes #106 (provider abstraction is now a YAML file). Absorbed #96 sub-shifts 3+4+5 (implementer fanout) into the v2 DAG default model.