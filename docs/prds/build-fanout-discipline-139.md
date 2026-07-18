# SPEC — build-step fanout + discipline-based agent routing (#139)

> ⚠️ **STATUS (2026-07-17): the `./scripts/install-seeds.sh` reinstall steps for the tech-lead agent seed below are SUPERSEDED by FG-578.**
> Since FG-578, `install-seeds.sh` — with or without `FORCE=1` — no longer overwrites an already-installed
> operator-authored seed (`agents/`, `constraints/`, `forge-raci.md`): it seeds each once, then retains your
> copy. So re-running the installer to propagate an edit to `seeds/agents/tech-lead/CLAUDE.md` is a **silent
> no-op** if `~/.forge/agents/tech-lead/` already exists — remove that copy first to re-test the edit.
> Forge-owned seeds (`workflows/`, `runtimes/`, skills) still refresh normally under `FORCE=1`, so the
> `feature.yml` reinstall steps below are unaffected. **The build-fanout discipline this PRD specifies is unchanged.**


> ⚠️ **STATUS (2026-07-16): the `forge dashboard start` regression check below is SUPERSEDED by FG-571.**
> It recorded a point-in-time check when there was one `forge` — the live checkout. FG-571 splits stable from
> dev; the dashboard is a separate workspace, not bundled into a release, so stable `forge` **refuses**
> `dashboard` in release mode. The equivalent check today is `./bin/forge-dev dashboard start` from a source
> checkout. **The build-fanout discipline this PRD specifies is unaffected and stands.**
> **UPDATE (FG-580, `bc9286f`):** the dashboard is now bundled into the release and `forge dashboard` runs
> from a promoted release (operator Option A); the release-mode refusal above is retired.


**Status:** draft, awaiting confirmation
**Backlog linkage:** closes #139. Composite with #116 (v2 cutover — this is the unfinished tail of the build-phase decomposition that originated as #96).

## Objective

The v2 runner already has full fanout machinery (DAG-driven dispatch, `max_concurrency`, `failure_mode`, parent-task tracking). Today's `feature.yml` build step doesn't use it — it's a single `engineer` invocation, no `fanout:` block. Multi-discipline features (frontend + backend + infra in one feature) funnel through the generic `engineer` agent, losing the four specialist seeds we already built (`frontend-specialist`, `backend-specialist`, `security-advisor`, `agentic-platform-builder`).

This spec wires that gap. After it lands:

- The `tech-lead` agent emits a `discipline` field per plan-step.
- The fanout machinery learns to **route the agent per child** based on a per-input discipline lookup (`agent_map` declared in the workflow YAML, fallback to `step.agent`).
- `feature.yml`'s build step becomes a fanout: one child task per plan-step, agent chosen per child's discipline.
- Reds stay **on the parent** (unchanged) — they review the aggregate diff after all children settle, same as today.

The planner is the load-bearing discipline: plan-steps must be **file-independent**. Two steps that touch the same file MUST be merged into one. This eliminates the need for inter-child DAG dependencies within a phase — the runner can dispatch all children in parallel and never worry about race conditions on the working tree.

## Out of scope (deferred)

- **Inter-child dependencies within a phase.** Planner discipline (file-independence) makes this unnecessary. If a future plan genuinely needs serialized steps (e.g. schema migration before code change), the right move is to split into two phases, not add intra-phase DAG.
- **Per-child reds.** Reds stay on the parent. The "specialists earn their tokens" framing argues for per-child reds, but the container-cost ratio (5 children × 5 reds = 25 reds per build) doesn't pencil out today. Revisit if a real run surfaces a defect class that per-parent red review missed.
- **`agent_map` discipline normalization.** Map keys are matched verbatim against the input's `discipline` field. No case-folding, no aliasing, no fuzzy match. If the planner emits `"Frontend"` instead of `"frontend"`, the fallback fires. Brittle by design — keeps the contract small.
- **Validating that `agent_map` agent names exist on disk.** YAML schema doesn't try to resolve agent dirs at load time. A missing agent dir surfaces as a spawn-time failure, same as for any other `step.agent` typo.
- **Updating other workflows** (`feature-ui-design-needed`, `feature-ui-design-provided`). This spec touches only the base `feature.yml`. The UI-design variants can pick up the same pattern in a follow-up if they want it.
- **Adding tests to the `tech-lead` agent's output format.** The seed change is prompt text; it's not directly testable in the existing test architecture. Validation lands at the runner level (does fanout correctly handle a discipline field?).

## Commands (no new CLI surface)

This spec adds zero new CLI flags, subcommands, or arguments. Behavior change is at the workflow-YAML + runner layer; users invoke `forge new feature` exactly as today, and `forge next <run-id>` drives the same way. The visible difference is that the build step's child tasks have different `agent_role` values per discipline.

## Project structure (files touched)

### Schema (small)

- `src/v2/schema.ts` — extend `FanoutDefSchema` with two optional fields:
  - `agent_map: Record<string, string>` — discipline value → agent role name.
  - `discipline_key: string` (default: `"discipline"`) — the field name on each input value that carries the discipline.

  Both are optional. When `agent_map` is unset, today's behavior is preserved (every child gets `step.agent`).

### Runner (small)

- `src/v2/runNext.ts` — `runFanoutChild` (around the current `step.agent ?? "fanout"` call sites) gains an agent-resolution helper:
  ```
  function resolveChildAgent(step, fanout, value): string
  ```
  Logic: if `fanout.agent_map` is set AND `value` is an object AND `value[fanout.discipline_key ?? "discipline"]` is a string AND that string is in `agent_map`, return the mapped agent. Otherwise return `step.agent` (the fallback).

  The function is exported for unit testing. Side-effect: the inserted child task's `agentRole` reflects the resolved agent (not `step.agent`), so dashboard/CLI views show the right role per child.

### Seed (small)

- `seeds/agents/tech-lead/CLAUDE.md` — extend the output schema:
  ```
  {
    "status": "complete",
    "steps": [{
      "id": "1",
      "summary": "...",
      "files": ["src/..."],
      "acceptance": "...",
      "discipline": "frontend" | "backend" | "infosec" | "platform" | "general"
    }]
  }
  ```
  Add a load-bearing section titled **"Steps must be file-independent"**:
  > Two steps that touch the same file MUST be merged into one. The runner dispatches plan-steps in parallel; overlapping file lists become race conditions on the working tree that no test will catch. If you find yourself wanting two steps with overlapping `files`, that's one step. Independence at planning time is the runner's correctness contract.

  Add a section explaining the discipline values: when `frontend` (anything under `src/dashboard/`, `client/`, `*.tsx`, `*.css`), when `backend` (`src/store/`, `src/spine/`, server APIs), when `infosec` (auth, secrets, RBAC), when `platform` (CI, build, infra config), when `general` (anything that doesn't fit cleanly — falls back to the generic `engineer` agent).

  After updating, `./scripts/install-seeds.sh` to copy into `~/.forge/agents/tech-lead/`.

  > _FG-578: `agents/` is authored-exempt, so this only copies when `~/.forge/agents/tech-lead/` is absent. If it already exists, the installer retains it and the copy is a no-op (with or without `FORCE=1`) — remove the dir first to re-test an edit._

### Workflow YAML (small)

- `seeds/workflows/feature.yml` — convert the build step to fanout:
  ```yaml
  - id: build
    agent: engineer                    # fallback for steps without a mapped discipline
    model: spec-writer
    depends_on: [plan]
    gate: verdict
    workflow_additions: |
      Implement your plan-step (passed via inputs.step). Output {step_completed, diff_summary, files_modified}.
    fanout:
      from_upstream:
        step: plan
        array_key: steps
        input_key: step
      agent_map:
        frontend: frontend-specialist
        backend: backend-specialist
        infosec: security-advisor
        platform: agentic-platform-builder
      max_concurrency: 4
      failure_mode: fail-phase
    reds:
      # unchanged from today — reds stay on the parent build step
      - agent: red-wide
        model: fast-orchestrator
        authority: authoritative
        gate_on_verdict: true
      # ... (red-narrow, red-frontend, red-backend, red-security as today)
  ```
  Reinstall via `./scripts/install-seeds.sh` after editing.
  - _FG-578: `seeds/agents/tech-lead/` is an authored-exempt category — the installer seeds it once and thereafter retains an existing `~/.forge/agents/tech-lead/` (`FORCE=1` included), so an edit only lands on a fresh copy; remove that dir first to re-test. `seeds/workflows/feature.yml` is forge-owned and still overwrites under `FORCE=1`._

### Tests

- `src/v2/runNext.test.ts` (or a new `src/v2/fanout.test.ts` if the existing file is crowded) — exercise the agent-resolution helper directly:
  - `resolveChildAgent: returns mapped agent when discipline matches`
  - `resolveChildAgent: returns step.agent fallback when discipline not in map`
  - `resolveChildAgent: returns step.agent fallback when discipline_key missing on input`
  - `resolveChildAgent: returns step.agent fallback when input is not an object`
  - `resolveChildAgent: respects custom discipline_key (not default "discipline")`
  - `resolveChildAgent: returns step.agent when agent_map is undefined`

- Schema test for the new fields:
  - `WorkflowSchema: fanout.agent_map and discipline_key parse correctly`
  - `WorkflowSchema: fanout without agent_map still validates (backwards compatible)`

### Docs (light)

- `docs/concepts.md` — extend the **Phase** entry to mention fanout + per-child agent resolution; OR add a new **Fanout** glossary entry. (Probably the latter — fanout is a distinct primitive.)
- `docs/how-to-new-workflow.md` — add a short section on declaring `fanout.agent_map` for discipline-driven routing. Example using the build step as the canonical case.

## Code style

- TypeScript strict mode, `noUncheckedIndexedAccess` on. Run `npm run typecheck` and `npm test` before commit.
- ES modules; `.js` suffix on every import from a `.ts` file.
- Zod schema follows the existing `FanoutDefSchema` pattern (optional fields, no superRefine unless validation truly needs it).
- The `resolveChildAgent` helper is a pure function. No side effects. Exported for testability.
- No comments unless WHY is non-obvious. The `discipline_key` default deserves a one-line WHY ("named to match the AgentDiscipline type in src/types/").

## Testing strategy

Baseline: 230/230 forge tests pass on `main` at `2b2e212`. Dashboard typecheck clean.

### New tests (covered above)
- ~6 tests for `resolveChildAgent` helper
- ~2 tests for the schema extension

### Manual verification (the spec is not done without these)

After implementation:

1. **End-to-end smoke run.** `forge new feature "smoke-fanout" --brief "add two trivial functions, one in src/store/ and one in dashboard/client/, with type signatures and a one-line implementation each" --ticket FG-139`. Walk through architect → plan (verify the tech-lead emits two steps with `discipline: backend` and `discipline: frontend` respectively) → build (verify the fanout dispatches two children, one with `agentRole: backend-specialist`, one with `frontend-specialist`).
2. **Fallback path.** Same brief but with a `general` step (e.g. "add a comment to BACKLOG.md") — confirm child task uses `agentRole: engineer`.
3. **Backwards compat.** Run an existing investigation or design workflow — confirm nothing breaks (other workflows don't have `agent_map`; their fanouts continue to use `step.agent`).
4. **Parent reds.** Confirm `red-wide`/`red-narrow`/`red-frontend`/`red-backend`/`red-security` run once on the parent build task after children settle, not once per child.
5. **CLI/dashboard render.** `forge status <run-id>` shows each child with its resolved `agentRole`. Dashboard activity feed shows each child by its specialist role.

### Regression check
- `npm run typecheck` clean
- `npm --workspace=dashboard run typecheck` clean
- `npm test` — 230/230 + the new tests pass
- `forge dashboard start` still boots

## Boundaries

### Always do
- Preserve backwards compatibility for fanouts that don't declare `agent_map`. Today's behavior (every child uses `step.agent`) must be the default.
- Keep `step.agent` as the load-bearing fallback. Never spawn a child with no agent.
- Keep reds on the parent. Per-parent red dispatch is the spec; per-child is explicitly out of scope.
- Run `npm run typecheck` + `npm test` + `npm --workspace=dashboard run typecheck` before commit.
- Reinstall seeds (`./scripts/install-seeds.sh`) after editing `seeds/agents/tech-lead/CLAUDE.md` or `seeds/workflows/feature.yml`.
  - _FG-578: the `tech-lead` edit only lands on a fresh `~/.forge/agents/tech-lead/`; on an existing one the installer retains it (no-op, `FORCE=1` included) — remove that dir first to re-test. `feature.yml` is a forge-owned `workflows/` seed and still overwrites under `FORCE=1`, so that half is unaffected._

### Ask first about
- Any change to `dispatchFanoutStep` beyond inserting the agent-resolution helper.
- Any change to existing fanout YAML in other workflows (this spec only touches `feature.yml`).
- Renaming or adding fields to the `tech-lead` output schema beyond `discipline`.
- Promoting `agent_map` or `discipline` to required (today both optional).
- Changes to the orchestrator template (the orchestrator-template change for cross-project workspaces is recent; don't reopen it here).

### Never do
- Add inter-child dependency handling to fanout (out of scope; planner discipline owns this).
- Change `step.agent` from optional to required on a fanout step (the fallback contract requires it stay optional in the schema but truthy at the call site — superRefine already enforces "non-manual steps must declare an agent," so the fallback is always populated).
- Move reds from parent to child (out of scope).
- Touch the verdict aggregation rule in `gate.ts`.
- Touch the Docker spawn pattern in `spawn.ts` (DEC-004, DEC-005, DEC-006, DEC-009).
- Change the state-machine status values (`pending|running|awaiting_gate|awaiting_human_input|awaiting_red|complete|failed|blocked_by_red`).
- Estimate work in days/weeks.

## Implementation order (dependency chain)

1. **Schema extension.** Add `agent_map` and `discipline_key` to `FanoutDefSchema` in `src/v2/schema.ts`. Add the two schema tests. `npm run typecheck` clean.
2. **Runner helper.** Add `resolveChildAgent` in `src/v2/runNext.ts`. Wire it into the existing `runFanoutChild` call sites so the inserted child task's `agentRole` reflects the resolved agent. Add the six unit tests. `npm test` passes.
3. **Tech-lead seed.** Update `seeds/agents/tech-lead/CLAUDE.md` with the new output schema, the file-independence section, and the discipline-classification guidance. Reinstall seeds. _(FG-578: `agents/` is authored-exempt — the reinstall no-ops if `~/.forge/agents/tech-lead/` already exists, even with `FORCE=1`; remove that dir first to re-test.)_
4. **feature.yml.** Add the `fanout:` block to the build step with the four discipline mappings. Reinstall.
5. **Manual verification.** Run the five steps under "Manual verification" above. Capture results.
6. **Docs.** Update `docs/concepts.md` (Fanout entry) and `docs/how-to-new-workflow.md` (agent_map example). Light touch.
7. **Backlog hygiene + commit.** Close #139 with the commit sha. Update BACKLOG notes.

Each step is independently verifiable. Pause for review between steps if anything surprises — especially if step 5's smoke run produces a tech-lead plan that *doesn't* split disciplines cleanly. That'd be a seed-tuning loop, not a code change.
