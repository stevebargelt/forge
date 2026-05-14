# forge v2 — YAML schema reference (draft)

This document is the schema specification for the YAML files that will replace
the TypeScript `Workflow` objects under BACKLOG #116. Schema decisions locked
during a paired session 2026-05-13 after translating all seven existing
workflows + the bedrock runtime as side-by-side drafts.

The drafts live next to this doc: `feature.yml.draft`, `investigation.yml.draft`,
etc. They are the source of truth for what fields exist and how they're used.
This doc explains the schema; the drafts demonstrate it.

## Two schemas, two files

- **Workflow YAML** — declares the steps + their wiring (gates, reds, fanout,
  onReject). Stored at `~/.forge/workflows/<name>.yml` by default; overridden by
  `<project>/.forge/workflows/<name>.yml` (full replacement, not merge).
- **Runtime YAML** — declares how to spawn an agent container for a particular
  provider (claude-bedrock, claude-oauth, claude-apikey, future codex). Stored
  at `~/.forge/runtimes/<name>.yml`. Each workflow step's `runtime:` field (when
  added — currently implicit "claude") resolves to a runtime YAML file.

## Workflow schema

### Top-level fields

| field | required | type | meaning |
|---|---|---|---|
| `name` | yes | string | Matches the filename without `.yml`. `forge new <name>` resolves here. |
| `description` | yes | string | One-line description; shown in the dashboard's new-run picker. |
| `inputs` | yes (may be `[]`) | list of InputDef | What `forge new` collects from the user. |
| `steps` | yes | list of Step | The pipeline. |

### `inputs` — what `forge new` collects

Each input becomes a CLI flag (`--<name>`) and a field in `inputs.*` inside the
task package. Order matters only for dashboard form layout.

```yaml
inputs:
  - name: brief
    required: true
    type: text       # text | path | textarea
    help: "Free-form description shown in the UI."
```

Today's CLI flags map directly:
- `--brief` → `name: brief, type: text`
- `--question` → `name: question, type: text`
- `--prd` → `name: prd, type: path`
- `--design-dir` → `name: design_dir, type: path`

The runner validates required inputs at `forge new` time; missing required
inputs error before any container spawns.

### `steps` — the pipeline

Each step is one node in the workflow graph. Steps execute in topological order
derived from `depends_on`; siblings with no remaining unmet deps may run in
parallel (runner's choice, not the schema's concern).

| field | required | type | meaning |
|---|---|---|---|
| `id` | yes | string | Unique within the workflow. Referenced by `depends_on` and `on_reject`. |
| `agent` | conditional | string | The agent role name. Must exist at `~/.forge/agents/<role>/`. Omit when `manual: true`. |
| `model` | no | string | Model alias (e.g. `spec-writer`, `fast-orchestrator`). Resolved via the runtime YAML's `models` map. Defaults to runtime's `models.default`. |
| `runtime` | no | string | Which runtime YAML to use (e.g. `claude`). Defaults to workspace default in `runtimes.<name>` map. |
| `depends_on` | no | list of step `id` | This step waits for these to finish. Empty/omitted means "no prereqs" — runs as soon as the run starts. |
| `gate` | no | `human` \| `verdict` \| `auto` \| `none` | Default: `none`. See gate semantics below. |
| `on_reject` | no | step `id` | If a human rejects this step at the gate, requeue *this* step's pending downstream side, and loop the run pointer back to the named step. |
| `workflow_additions` | no | multiline string | Extra system-prompt text appended to the agent's CLAUDE.md for this step only. Today's `workflowAdditions`. |
| `manual` | no | boolean | `true` = no agent runs; the human submits artifacts via `forge submit`. Default `false`. |
| `reds` | no | list of RedDef | Adversarial reviewers spawned in parallel after the step's agent finishes. See "Reds block" below. |
| `fanout` | no | FanoutDef | This step spawns N parallel agent containers. See "Fanout" below. |

### Gate semantics

- `gate: auto` (**default**) — advance immediately on step completion. The orchestrator (host-side Claude Code talking to the user) reads the artifact and decides whether to escalate to the human or let the pipeline proceed. No SQLite pause; no dashboard wait.
- `gate: human` — pause; write `awaiting_gate` to SQLite; show in dashboard; wait for explicit advance/reject/request-changes from the human. Use when human taste is irreducible (final approval, UI design review).
- `gate: verdict` — wait for all `reds` to complete, aggregate verdicts (see `authority`), then auto-advance if all authoritative reds pass. Human can still force-advance over a failed authoritative red with rationale (#110).
- `gate: none` — same as `auto`. Kept in the schema for explicit "no gate intended" annotation when readability matters.

**Default flip from v1.** Forge today defaults every phase to `gate: human`, producing 5 human gates per feature run. v2 flips this: `gate: auto` is the default and the orchestrator becomes the gate-verifier-by-default. Workflows declare `gate: human` explicitly on steps that genuinely need human taste. See STATUS.md "Conversational entry — orchestrator pattern" for the full rationale.

**Orchestrator-mediated gate behavior:** when a step completes with `gate: auto`, the runner writes the task as `complete` (not `awaiting_gate`). The orchestrator queries `forge status` periodically, reads the just-completed step's `result.json`, forms an opinion, and either dispatches the next step via `forge next` or surfaces a concern to the human ("planner output looks thin in step 3 — want me to reject?"). This matches Jeff's autonomous-gate-handling pattern, which is proven production behavior.

### Reds block

Reds are adversarial reviewers attached to a step. They spawn in parallel
*after* the step's primary agent completes. Each red gets the step's artifact
as its inputs (`artifact_under_review` field), runs read-only, and emits a
Verdict.

```yaml
reds:
  - agent: red-wide
    model: fast-orchestrator
    authority: authoritative   # authoritative | specialist
    gate_on_verdict: true      # if false, verdict is informational only
```

- `authority: authoritative` — this red's `fail` blocks `gate: verdict`
  advancement unless force-advanced with rationale.
- `authority: specialist` — this red's `fail` doesn't block on its own
  (#113 framing: discipline reds were specialist before this, now mostly
  authoritative; `specialist` mode kept for architect/synthesize-phase reds
  that are informational).
- `gate_on_verdict` — independent of `authority`; declares whether THIS red's
  verdict contributes to the gate decision at all. A specialist red with
  `gate_on_verdict: false` is purely informational.

Reds always run with read-only project mounts; the runner enforces.

### Fanout

A step with a `fanout` block spawns N parallel agent containers instead of one.
Each container is identical except for the per-container input bound from an
upstream step's array output.

```yaml
fanout:
  from_upstream:
    step: frame-question     # which upstream step produces the array
    array_key: claims        # field name in that step's result.json
    input_key: claim         # name under which each element is bound in this step's inputs
  max_concurrency: 4         # cap on simultaneous containers
  failure_mode: continue     # fail-phase | retry-once | continue
```

Failure modes:
- `fail-phase` — first failed fanout container fails the whole step.
- `retry-once` — failed container gets one retry; persistent failures fail-phase.
- `continue` — failed containers are recorded but don't block siblings or
  downstream steps. Used by investigation + codebase-assessment today.

The fanout schema is **already in production use** in `investigation.yml` and
`codebase-assessment.yml` (under the TS Workflow type — being translated here).
Not a v2 invention.

### Manual steps

A step with `manual: true` has no agent and no automatic execution. The
runner creates the step's task row in `pending` status and waits. The human
does work off-forge (today: runs PROMPT.md against Pencil + Claude Code) and
calls `forge submit <task-id>` (or hits the dashboard button), which
transitions the step to `awaiting_gate`. Gate semantics apply normally from
there. `on_reject` loops back to an earlier step that will produce a revised
input.

Manual steps must declare `gate: human` (other gate types are meaningless
without an agent to verdict-on).

## Runtime schema

### Top-level fields

| field | required | type | meaning |
|---|---|---|---|
| `name` | yes | string | Matches the filename without `.yml`. Referenced by `step.runtime`. |
| `description` | yes | string | Human-readable. |
| `detect` | no | DetectDef | Pre-flight that picks this runtime when multiple are available. |
| `image` | yes | string | Docker image to run. |
| `models` | yes | map | Alias → concrete model ID. `default` is required. |
| `auth` | yes | AuthDef | How to authenticate the container. |
| `env` | no | map | Env vars passed unconditionally. Values may use `${VAR:-default}` syntax. |
| `mounts` | yes | list of MountDef | Bind mounts. |
| `invocation` | yes | InvocationDef | Command, args, stdin to launch the agent CLI. |
| `container` | yes | ContainerDef | Lifecycle: name template, remove-on-exit, idle timeout. |
| `result` | yes | ResultDef | Where to read the agent's result.json + stdout/stderr logs. |

### Auth modes

Two modes today, both for bedrock:

- `env-snapshot` (default per #121) — host calls `aws configure
  export-credentials` before docker run; injects `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` as `-e` vars.
- `mount` — bind-mount `~/.aws:/home/agent/.aws:ro`. Container's SDK derives
  STS. Failure mode documented in #121; opt-in for long-running containers.

Other providers (`anthropic-oauth`, `anthropic-apikey`) each get their own
runtime YAML with a different `auth.mode`. Provider abstraction (BACKLOG #106)
closes through this surface: adding OpenAI/Codex is a new runtime YAML, not
typed code.

### Template substitution

Mount paths, env values, and invocation args support `${VAR}` and
`${VAR:-default}` substitution. Runner-supplied variables:

| variable | meaning |
|---|---|
| `${TASK_DIR}` | Host path of `~/.forge/runs/<run>/<task>/`. |
| `${TASK_ID}` | The task ID. |
| `${PROJECT_DIR}` | Host path of `--project`. |
| `${PROJECT_MODE}` | `rw` for blue agents, `ro` for reds. |
| `${DESIGN_DIR}` | Host path of `--design-dir` if set, empty otherwise. |
| `${MODEL}` | Resolved model ID from the step's `model:` alias. |
| `${SYSTEM_PROMPT}` | Composed system prompt (agent CLAUDE.md + workflow_additions + constraints). |
| `${TASK_PACKAGE_MARKDOWN}` | Rendered task package (used as stdin to claude). |

Plus any process-env variable (e.g. `${AWS_REGION:-us-east-1}` reads the host's
`AWS_REGION` env, defaulting to `us-east-1` if unset).

### Optional mounts

A mount with `optional: true` is skipped silently if the host path doesn't
exist. Used for `--design-dir` (not all runs have one) and the browser-tools
skill mount (not all hosts have pi-skills cloned).

## What's NOT in the schema

- **Cross-step communication beyond `inputs.upstream[*]`** — steps see upstream
  results via the canonical task package; no shared scratch space, no message
  passing. Matches today.
- **Conditional steps** — there's no `if:` field. The workflow graph is static
  per-workflow. Use separate workflows for forks.
- **Loops** — `on_reject` is the only loop primitive. No `while` / `until`.
- **Per-step credential overrides** — auth lives at the runtime level, not the
  step level. Every step in a workflow shares one runtime.

## Open design questions (decide before runner work)

1. **`fanout.from_upstream.step` field — is "the previous step" implicit, or
   always required to name?** Today's `fanoutFromUpstream` uses the
   *immediate previous phase*. The drafts above are explicit (`step: scope`).
   Explicit is more verbose but unambiguous in DAGs where "previous" is
   ill-defined.
2. **`workflow_additions` substitution** — does it support template variables
   (`{{BRIEF}}`, etc.) like Jeff's runtime invocation does? Today's TS version
   doesn't; the agent reads `inputs.*` directly from the task package. Sticking
   with that: no substitution in `workflow_additions`. Confirm.
3. **`inputs.upstream[*]` shape exposed to the agent** — today the spine builds
   `inputs.upstream[*]` from the prior phase's tasks. In a DAG world, which
   ancestors does "upstream" mean? **Lean: only direct `depends_on` ancestors,
   one level back.** Matches today's "previous phase" semantics. Confirm.
4. **Step result schemas** — today's spine doesn't validate result.json shapes
   beyond `{status: ...}`. v2 could enforce per-step Zod schemas from a
   `result_schema:` block. **Lean: defer.** Schemas live in the agent's CLAUDE.md
   today as documentation; runner-level validation is a "later" feature.

## Translation status (workflow files drafted)

- ✓ `feature.yml.draft`
- ✓ `feature-ui-design-provided.yml.draft`
- ✓ `feature-ui-design-needed.yml.draft`
- ✓ `investigation.yml.draft` (uses fanout)
- ✓ `codebase-assessment.yml.draft` (uses fanout)
- ✓ `ui-design.yml.draft` (manual step)
- ✓ `ui-design-revise.yml.draft` (manual step)

All seven workflows fit the schema as drafted. No schema escape hatches needed.

## Next steps

1. Review this doc + the drafts; lock the four open design questions above.
2. Write Zod schemas in `src/v2/schema.ts` (or wherever the v2 namespace lives).
   These validate YAML at load time and surface useful errors on malformed input.
3. Write the runner: walks steps in topological order, spawns containers via
   the runtime YAML, writes to existing SQLite tables, calls existing
   `gate.ts` at gate decision points.
4. Wire `forge new` to read inputs from the workflow's `inputs:` block.
5. Translate the install layer: `seeds/agents/<role>/` becomes the source for
   `~/.forge/agents/<role>/` install; same for `runtimes/`.
6. Delete the TS spine.

## Notable shape differences from today's TS Workflow type

- **`gate: "auto"` is preserved** (it's a third gate type today).
- **Manual steps are first-class** via `manual: true` rather than
  `agents: []`.
- **Reds are a list of dicts** instead of `{ wide, narrow, additional, parallel, authority, gateOnVerdict }`.
  Each red carries its own authority + gate_on_verdict; no shared block-level
  defaults. More explicit, less DRY. Matches the list-of-dicts shape.
- **DAG via `depends_on`** replaces today's implicit "next phase in array."
  Linear workflows look identical (each step depends on the previous); fanout
  and parallel siblings become expressible without schema additions.
- **`inputs:` block declares what `forge new` collects.** Today this is
  scattered in `src/dashboard/workflowSchema.ts` and `src/cli/commands/new.ts`.
  Centralizing in the workflow YAML matches Jeff's pattern.
