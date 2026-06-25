# Concepts

Glossary of forge terms. One paragraph each, with a concrete example from `run-litellm-eval`.

## Run

A single workflow invocation. Created by `forge new`, given a unique id like `run-litellm-eval-96a1da`. Recorded in the `runs` table with status `active` | `complete` | `abandoned`, plus the `projectDir` of the directory it was created from. SQLite is the resume state — a run that's parked at a gate survives reboots.

Example: `forge new research-synthesis "litellm-eval" --question "Does LiteLLM solve provider routing?"` creates one run.

## Project

The directory mounted at `/project` in the agent container. Recorded on each run as `runs.project_dir`. Implementer agents see it read-write; red agents see it read-only at the OS level (FORGE-DEC-006).

On `forge new` / `forge invoke`, forge resolves the mount target before launching any container (FG-374, FORGE-DEC-022):

- **Not inside a git repo** — mounts cwd (or `--project <dir>`) unchanged.
- **Inside a git repo, no `--project` flag** — resolves up to the repo root (requires `.forge` or `package.json` there); prints an informational notice. Hard-fails if no confident root is found.
- **`--project <subdir>` pointing inside a git repo** — hard-fails in automation (no TTY or `--json`); warns-and-honors in interactive sessions. Pass `--allow-subproject` to override in both contexts.

Override with `--project <dir>` to target a different repo from your cwd. Pass `--allow-subproject` when you intentionally want a subdir mount (records `explicitSubproject: true` in the task manifest).

Example: a run created via `cd ~/code/my-app && forge new feature "add login" --brief "..."` has `projectDir = /Users/you/code/my-app`. Every container spawned for that run mounts that path at `/project`.

## Workspace

The cwd of the human running `forge`. For most runs the workspace equals the project (you're in `~/code/my-app` and the run drives changes to `~/code/my-app`). They diverge when an orchestrator session in one directory drives runs against a different project — e.g. `~/code/audit-workspace` orchestrating runs whose `projectDir` is `~/code/forge`. `forge new` and `forge invoke` stamp the workspace into `metadata.workspace` (default: cwd; override with `--workspace`). `forge status` filters by workspace (matching either `projectDir == cwd` or `metadata.workspace == cwd`) by default; use `--all` to see runs across every project on the host.

## Slash commands

Custom Claude Code commands forge installs into each project's `.claude/commands/`. Invoked as `/<name>` inside a Claude Code session. Two ship today:

- **`/orient`** — start-of-session orientation. Runs `forge backlog notes show` + `forge backlog list --status active` + git state + `forge projects show <project>` in parallel, reports a compact state-of-play, ends with "What's the priority?" Never re-states the orchestrator role (the CLAUDE.md block already does); performing the start-of-session protocol IS the demonstration.
- **`/handoff`** — end-of-session ritual. Drafts the backlog notes block in the forward-looking shape (where-we-left-off / picked-up-next / external state / decisions worth not relitigating / shipped-for-reference), applies via `forge backlog notes replace` without a review pause, and reports unpushed-commit count.

Both commands hard-code "use the `forge backlog` CLI, do NOT read backlog files directly." The CLI is the bounded interface that protects orchestrator context cost; projects store notes at `backlog/notes.md` and tickets under `backlog/{stories,epics,ideas,done}/`.

`forge backlog close <id>` moves a ticket to `backlog/done/`, sets `status: done`, and records a `closed` date in its frontmatter. Pass `--commit <sha>` to also stamp the closing commit: the done ticket gains a `closed_commit: <sha>` field, tying the ticket to the exact commit that shipped it.

Installed by `forge init` as symlinks into the local forge clone (so `forge upgrade` propagates template edits to all projects without per-project re-copy). `--no-install-hooks` bypasses installation. Project-local overrides (a regular file at `.claude/commands/<name>.md`) are detected as `exists-other` and left alone. Stale forge symlinks pointing at a different/old forge clone path are detected and replaced in place on upgrade.

**Portability convention (`.claude/commands/` is per-developer):** the symlinks contain machine-absolute paths to *this developer's* forge clone, so they're not portable across contributors. `forge init` adds `.claude/commands/` to the project's `.gitignore`. Each contributor runs `forge init` once after cloning to bootstrap their local copies — same shape as `npm install` reconstructing `node_modules/`.

## Orchestrator heartbeat

A liveness signal for the Claude Code session that's currently acting as a project's orchestrator. `forge init` installs three Claude Code session hooks (SessionStart / Stop / SessionEnd) into `<project>/.claude/settings.local.json` (per-developer, gitignored — see Slash commands above for the portability rationale); those hooks invoke `scripts/claude-hooks/orchestrator-heartbeat`, which maintains a JSON file at `~/.forge/orchestrators/<session-id>.json` containing `{sessionId, projectDir, startedAt, lastSeen}`. SessionStart writes it, Stop touches `lastSeen` after every assistant turn, SessionEnd deletes it. A heartbeat whose `lastSeen` is within the last 15 minutes is considered live; older ones are stale (likely a crashed session). `forge projects list` shows live projects with a ● and floats them to the top.

Projects installed before this convention shipped had forge hooks in `<project>/.claude/settings.json` (the committed file). `forge upgrade` migrates those automatically — strips the forge entries from `settings.json` (preserving any other user keys + hooks) and writes a fresh `settings.local.json`.

## Design corpus

The per-project shared design directory (#67). Default location: `<project>/designs/` — version-controlled with the project, treated as a project artifact rather than a peer dir. Every design-touching workflow run (`ui-design`, `ui-design-revise`, `feature-ui-design-needed`) targets the SAME corpus, which grows monotonically across runs.

Layout (flat — no `designs/` subdir inside designDir):
- `<project>/designs/<project-name>.pen` — single Pencil source file; filename = `basename(projectDir)` by default. If a `*.pen` already exists, the prompt-author preserves whatever name the human chose.
- `<project>/designs/NN-<screen-name>.png` — two-digit zero-padded screen exports at the top level. New runs start numbering at `max(existing) + 1` (no clobber).
- `<project>/designs/code/NN-<screen-name>.html` — optional HTML+CSS reference exports.

Override the default with `forge new --design-dir <path>` (e.g. point at a shared-across-repos design system like `~/code/forge-design/`). For legacy peer-dir setups that still have a `<designDir>/designs/` PNG subdir, the prompt-author detects and respects the existing layout (#80).

Each design-touching run's prompt-author classifies every requested screen as **new** (add a frame), **addition** (annotation to an existing component — placed adjacent on canvas, do not redraw), or **modify-in-place** (edit the existing frame, re-export with the same numeric prefix — git is the audit trail). See seeds/agents/prompt-author/CLAUDE.md.

## Task

The unit of work. Every agent invocation is one task. Recorded in the `tasks` table with the lifecycle `pending → running → (complete | failed | awaiting_gate | blocked_by_red)`. A task carries a *task package* (the inputs the agent receives) and, after running, a *result* (the structured JSON the agent produced).

Example: the framer task `task-frame-f68eb8` produced 5 claims and 7 experiments as its result.

## Phase

A fixed step in a workflow. Phases run in order; each phase has one or more agent roles, an optional set of red agents, and a gate. Phases are defined in YAML workflow files under `~/.forge/workflows/` (seeds at `seeds/workflows/`).

Example: the research-synthesis workflow has four steps — `frame`, `research-primary`, `research-skeptic`, `synthesize`.

## Gate

A decision point at the end of a phase. Three kinds: `human` (waits for `forge gate <task-id> advance`), `verdict` (passes if all reds pass; fails on any authoritative-red fail), and `auto` (advances on completion with no human input).

Example: the `frame` phase has a `human` gate. After framer completes, the run parks at `awaiting_gate` until `forge gate task-frame-f68eb8 advance` runs.

## Verdict

A red agent's output. Schema: `{verdict: "pass" | "fail" | "inconclusive", confidence, findings, notes}`. Recorded in the `verdicts` table. Verdicts inform but only block the gate when the red has `authority: "authoritative"` and the phase has `gateOnVerdict: true`.

Example: at `investigate`, the narrow red against task-inv-004 returned `{verdict: "fail", confidence: 0.85, findings: [...]}` and surfaced the cost-tracking weakness.

## Fanout

A step pattern where one workflow step spawns N child tasks, one per element of an upstream step's result array. Declared in YAML via `fanout: { from_upstream: { step, array_key, input_key }, max_concurrency, failure_mode }`. The fanout step has a single parent task (tracks aggregate state) and N children (each does the work for one upstream element). Reds, gates, and verdicts attach to the parent — children produce their own `result.json` but don't trigger reds individually.

The fanout step's `agent_map: Record<discipline, agentRole>` optionally routes each child to a different agent based on a discipline field on its input. Default routing field is `discipline`; override via `discipline_key`. Inputs that don't match any mapped discipline (or aren't objects) fall back to `step.agent`.

Example: the `feature` workflow's `build` step fans out one child per tech-lead plan-step. Each plan-step carries `discipline: frontend | backend | infosec | platform | general`; the `agent_map` routes to `frontend-specialist`, `backend-specialist`, `security-advisor`, `agentic-platform-builder` respectively. `general` (or any unmapped value) falls back to `engineer`.

## Red agent

An adversarial agent. Mounted **read-only** on the project at the OS level (not by prompt). Two stances: *wide* (generic disbelief, no specific failure mode) and *narrow* (anti-prompts derived from force-level constraints). Reds never see other panel members' findings or the blue's transcript. Both carry a `docs_drift` finding type: when a red detects that shipped code changes operator-visible behavior that the docs no longer describe, it files a finding anchored to the stale doc line (not the code). These findings feed the `documentation-maintainer`'s `stale_docs_found` input.

Example: at `synthesize`, the narrow red caught that the architectural-implications section overweighted LiteLLM in the Pi-vs-Gas-City decision.

## Documentation maintainer

A container agent (`documentation-maintainer`) responsible for keeping durable operator-facing docs accurate as the system changes. Its job is to fix *drift* — docs that are present but wrong — not to produce docs from scratch. It edits markdown and YAML example files only; source code is out of scope regardless of how small the change looks.

All three feature workflows include a `docs` phase that runs it automatically after `verify` (gate: `auto`), ensuring docs are reconciled every run without relying on the orchestrator to chain an explicit invoke. For ad-hoc operator-behavior changes outside the pipeline, the orchestrator also triggers it via `forge invoke documentation-maintainer`. Work-type routing: durable operator-/engineer-facing prose (`docs/**`, `learnings/**`, `README*`, seed prose, example configs and their comments) goes to this agent; ephemeral working-state (BACKLOG, session notes, task briefs) stays orchestrator-direct.

Output contract: `{ docs_updated, docs_not_updated_reason, stale_docs_found, operator_behavior_changed }`. A result with `operator_behavior_changed: true` and an empty `docs_updated` and no `docs_not_updated_reason` is a reject — if behavior changed and nothing was updated, the reason must be stated.

Example: the orchestrator invoked `documentation-maintainer` after the docs-drift system shipped to update `docs/concepts.md` with the new `documentation-maintainer`, `docs_drift`, and `Docs impact` entries.

## Constraint

A markdown file under `~/.forge/constraints/` with frontmatter declaring `level` (`suggest` or `force`), `roles`, `workflows`, optionally `phases`, and optionally `tags`. Suggest-level constraints are appended to the agent's CLAUDE.md (Tier 3 of `composeSystemPrompt`). Force-level constraints feed the narrow red as anti-prompts; they never relax to suggestions.

A constraint with no `tags` applies to every matching run (unchanged global behavior). A constraint with `tags` applies only when the run was created with a matching `--tag` value (`forge new --tag <tag>`). Tags are selection metadata only — they are never leaked into task prompts. This is the preferred alternative to renaming a constraint file `.disabled` to suppress it globally.

Example: `atlas-stack-rn.md` is a force-level constraint that locks the frontend stack to React Native and surfaces as an anti-prompt for the narrow red. To scope it to Atlas project runs only, add `tags: [atlas]` to its frontmatter and pass `--tag atlas` when creating Atlas runs — it stays inert on every other project's runs.

## Blocked by red

A status that means: a red came back authoritative-fail and the phase had `gateOnVerdict: true`. The CLI surfaces a `BLOCKED` state with the red's findings; the human cannot advance through the normal gate. Override requires `forge gate <task-id> advance --force --rationale "..."`.

Example: a build phase whose red detected a stack violation would set the build task to `blocked_by_red` automatically.

## Container crash vs. agent failure

Two failure modes, surfaced differently — but both emit `task.failed`; the machine-readable `failure_kind` in the event payload distinguishes them. **Container crash**: container exited non-zero with no result JSON (Docker issue, OOM, credential failure) → `failure_kind: "container_crash"` — unless the runtime's stdout carries a provider/model error (invalid model, quota, 4xx), in which case it's attributed as `failure_kind: "model_error"` with the cause (#228). **Agent failure**: container exited 0 and wrote a result JSON with `status: "failed"` and an error reason → classified per context. Different follow-up actions. (There is no `task.crashed` event type — the failure taxonomy lives in the `task.failed` payload, not in separate event types.)

## Agent-container settings isolation

Forge agents run with on-disk Claude Code settings discovery suppressed. Claude Code normally auto-discovers configuration from `<cwd>/.claude/settings*.json` (user, project, and local layers). Because the agent's working directory is the project bind mount, the orchestrator's own `.claude/settings.json` and `.claude/settings.local.json` — written for the host environment — are visible from inside the container. Without isolation those settings leak: an `env.CLAUDE_CODE_USE_BEDROCK` entry flips the agent's auth mode, a `model` field swaps the model forge selected, and `hooks` blocks reference host-only paths that crash on execution inside the container.

Forge passes `--setting-sources ""` to every claude-code runtime invocation, which suppresses all three discovery layers. Agents receive configuration only through what forge passes explicitly: environment variables injected by the runtime YAML, the `--model` flag, and `--append-system-prompt`. The flag is scoped to claude-code runtimes; codex and pi CLIs do not accept it and are not affected.

Example: if a project's `.claude/settings.local.json` contains `{ "env": { "CLAUDE_CODE_USE_BEDROCK": "1" } }` for the orchestrator's Bedrock session, without isolation every agent spawned for that project's runs would switch to Bedrock auth regardless of the runtime's declared auth mode — crashing silently if Bedrock credentials are absent inside the container, or silently switching auth if they're present.

## Docs impact

A run-level assessment of whether changes to operator-visible behavior have been reflected in durable docs. Three integrated signals:

1. **Contract flag.** A task's contract may declare `operator_behavior_changed: true` explicitly. When the orchestrator omits it, forge infers the value from the task's `files_modified`: if any path touches a defined operator surface, the flag is inferred as `true`. The surface list is project-configurable: add `<project>/.forge/docs-surfaces.yml` (shape: `{ surfaces: [<path-prefix>, ...] }`) to fully replace forge's built-in defaults for that project. Without that file, forge's own defaults apply (CLI commands, workflow seeds, runtime configs, the notify layer, the contract schema, etc.).

2. **`forge show` suggestion.** When displaying a completed task whose `files_modified` touched operator surfaces, `forge show` prints a suggestion line: `docs impact: operator surfaces changed (...) — durable docs may be stale; consider: forge invoke documentation-maintainer`. Advisory only — not a gate.

3. **Ship-time warning.** `forge notify milestone --kind shipped` assesses the full run before dispatching. If any task changed operator behavior and no task in the run reported `docs_updated` or a `docs_not_updated_reason`, the notification body includes an advisory warning naming the surfaces and suggesting `forge invoke documentation-maintainer --run <id>`. The warning never blocks shipping.

Resolution: the docs impact is considered resolved when a task in the run reports a non-empty `docs_updated` array (the `documentation-maintainer` ran and made changes) or a non-empty `docs_not_updated_reason` (a principled deferral was recorded). Recording a reason is equivalent to resolution — it makes the decision explicit and auditable.

Example: after the engineer modified `src/cli/commands/show.ts`, `forge show` printed a docs impact suggestion; the orchestrator chained `forge invoke documentation-maintainer --run <id>` and the maintainer updated this glossary.

## Campaign

An ordered collection of tickets that forge will work in sequence. Created by `forge campaign plan`, which resolves the input (ticket list, epic, or mixed) into a persisted campaign (status `planned`) with items (status `pending`) and a stable `plan_hash` computed from the canonical plan content. The campaign and its items are written to the database at plan time; no runs or tasks are created until `forge campaign start` executes the campaign.

`forge campaign plan` accepts three input modes:

- **List** (`--tickets <ids>`): explicit comma-separated ordered ticket ids — no epic expansion.
- **Epic** (`--epic <id>`): expands the epic's children in planner-determined order.
- **Mixed** (`--epic <id>` + `--add <ids>` / `--exclude <ids>`): epic children with additions or exclusions applied.

`--tickets` and `--epic` are mutually exclusive; `--add` and `--exclude` require `--epic`. Other flags: `--mode dry_run|pilot|sequential` (default `dry_run`), `--project <dir>` (default: cwd), `--json` (machine-readable output). Ambiguous flag combinations and invalid `--mode` values fail loudly.

Output: campaign id, ordered item list with lifecycle status, canonical plan content, and `plan_hash`. With `--json` the output is a single object `{campaignId, orderedItems, canonicalContent, planHash}`. The `plan_hash` is the fingerprint that `forge campaign start` re-verifies before dispatching any work — if the backlog has changed since approval, `start` refuses with `stale_plan`. See FORGE-DEC-023.

Example: `forge campaign plan --epic FG-100 --exclude FG-5 --mode pilot` plans a campaign from FG-100's children minus FG-5, in pilot mode.

### Approval

`forge campaign approve <campaign-id> --rationale <text> [--by <operator>] [--json]` records a durable approval on a planned campaign. The command stamps `approved_by`, `approved_at`, `approval_rationale`, and snapshots the current `plan_hash` as `approved_plan_hash` in the database.

Preconditions checked at approval time:

- The campaign must be in `planned` state; calling `approve` on any other status is an error.
- The campaign's stored `projectDir` must exist on disk and contain a `backlog` directory. A campaign with a missing or invalid project directory cannot be approved.

If the backlog has changed since the campaign was planned (re-resolving `sourceInput` now produces a different hash), `approve` emits a non-fatal warning but records the approval anyway. To establish a clean baseline after a backlog change, re-plan (`forge campaign plan`) and re-approve.

Approval is a durable state-machine precondition for execution: `forge campaign start` refuses if `approved_plan_hash` is not set. See FORGE-DEC-024.

### Start (sequential execution)

`forge campaign start <campaign-id> [--project <dir>] [--json]` executes an approved campaign one item at a time. Before dispatching any work, `start` evaluates preconditions in this order and exits non-zero on the first failure:

| Stop reason | Meaning | Fix |
|---|---|---|
| `not_planned` | Campaign status is not `planned` (already running, failed, or complete) | Inspect status with `forge campaign show <id>` |
| `no_project_dir` | Campaign predates `projectDir` capture | Re-plan with `forge campaign plan` |
| `invalid_project_dir` | Stored `projectDir` no longer exists or lacks a `backlog` directory | Restore the directory or re-plan |
| `not_approved` | `approved_plan_hash` is not set | Run `forge campaign approve <id> --rationale <text>` |
| `stale_plan` | Current plan hash (re-resolved from stored `sourceInput` against stored `projectDir`) differs from `approved_plan_hash` | Re-plan and re-approve |
| `dry_run_not_executable` | Campaign mode is `dry_run` — plan-and-report only; `start` refuses to dispatch any work or mutate the repo | Re-plan with `--mode pilot` or `--mode sequential` and re-approve |
| `already_running` | A `planned → running` CAS in the database rejected the transition — another `start` process already holds it | Wait or recover — see crash recovery below |

**Important:** `forge campaign plan` defaults to `--mode dry_run`. A `dry_run` campaign is plan-and-report only — `forge campaign start` will refuse it with `dry_run_not_executable`. To actually execute a campaign, plan with `--mode pilot` or `--mode sequential` and re-approve before starting.

If all preconditions pass, the campaign transitions to `running` via a compare-and-swap (CAS) and items execute **strictly one at a time** through the engineer agent. For each item a `run_id` is pre-allocated and persisted **before** dispatch — this is the crash evidence trail.

**Outcome semantics.** After an item's engineer task completes:

- The item is marked `outcome: shipped` only if the backlog ticket is `status: done` with a `closed_commit`. A completed agent task alone is never treated as shipped.
- If the ticket is done but lacks a `closed_commit`, the outcome is left unset.
- If the task fails, the item is marked `lifecycle: failed, outcome: failed`, the campaign transitions to `failed`, and execution stops. There is no auto-continuation; see FG-393.

**`--project` is verify-only.** If `--project <dir>` is provided, `start` checks that the resolved path equals the campaign's stored `projectDir` and refuses if they differ. It does **not** override the execution directory — the campaign always runs against the `projectDir` captured at plan time. Run `forge campaign start` from the same project root used for `forge campaign plan`, or pass `--project` pointing at that same root.

Example: `forge campaign start camp-abc123 --project ~/code/my-app` verifies the stored directory, then starts executing items sequentially.

### Crash recovery (MVP limitation)

`forge campaign start` holds its process for the campaign's entire duration, which may span several hours or overnight. **Crash recovery is not automated in this MVP.** If the `start` process dies mid-run (crash, SIGKILL, power loss):

- The campaign stays stuck in status `running`.
- A subsequent `forge campaign start` refuses with stop reason `not_planned`.
- Recovery evidence is durable: each item's `run_id` is persisted before dispatch. Run `forge campaign show <id>` to see which item was in flight when the process died.

**Note:** `forge campaign resume` only operates on a `paused` campaign. A campaign stuck in `running` after a process crash is not the same as paused — no automated recovery path exists yet; manual database intervention is still required.

**Manual crash recovery:**

```sql
-- Connect to the forge database (default: ~/.forge/forge.db) with the sqlite3 CLI.
-- Reset the stuck campaign back to planned:
UPDATE campaigns
   SET status = 'planned', updated_at = datetime('now')
 WHERE id = '<campaign-id>';

-- Reset the in-flight item back to pending:
UPDATE campaign_items
   SET lifecycle_status = 'pending', outcome = NULL, run_id = NULL, updated_at = datetime('now')
 WHERE campaign_id = '<campaign-id>' AND lifecycle_status = 'running';
```

Before re-starting, inspect the run that was in flight (using the persisted `run_id`) to determine whether the engineer agent finished before the crash. If the ticket reached `status: done` with a `closed_commit`, mark the item complete manually rather than re-dispatching the same work.

### Campaign lifecycle

Campaigns move through a fixed set of statuses. Control commands enforce legal transitions and refuse others with a clear error message and non-zero exit.

| From | To | Command |
|---|---|---|
| `planned` | `running` | `forge campaign start` |
| `planned` | `abandoned` | `forge campaign abandon` |
| `running` | `paused` | `forge campaign pause` (cooperative) |
| `running` | `complete` | automatic (all items processed) |
| `running` | `failed` | automatic (item failure) |
| `running` | `abandoned` | `forge campaign abandon` |
| `paused` | `running` | `forge campaign resume` |
| `paused` | `abandoned` | `forge campaign abandon` |

`complete`, `failed`, and `abandoned` are terminal — no further transitions are accepted.

### Show

`forge campaign show <id> [--json]` prints the current state of a campaign. Read-only; does not mutate any state.

Human output includes:

- Campaign status, mode, `projectDir`, and approved plan hash
- Staleness indicator: whether the current plan hash matches the approved hash
- The active item, if any (ticket id and run id)
- Per-item rows: ticket id, title, lifecycle status, outcome, blocker kind, continue policy, run id, reason, and requested human action
- A `Next action` line with the recommended operator step (`approve`, `start`, `resume`, `complete — none`, etc.)

With `--json`, the output is a single stable object:

```json
{
  "campaignId": "camp-abc123",
  "status": "paused",
  "mode": "sequential",
  "approvedPlanHash": "abc...",
  "currentPlanHash": "abc...",
  "planStale": false,
  "projectDir": "/Users/you/code/my-app",
  "activeItem": null,
  "items": [
    {
      "ticketId": "FG-10",
      "title": "Add login",
      "lifecycleStatus": "complete",
      "outcome": "shipped",
      "blockerKind": null,
      "continuePolicy": null,
      "runId": "run-fg-10-aabbcc",
      "reason": null,
      "requestedHumanAction": null
    }
  ],
  "nextAction": "resume"
}
```

Use `forge campaign show` for a quick status check; for a full checkpoint report use `forge campaign report`.

### Report

`forge campaign report <id> [--json]` generates a checkpoint or final campaign report. Read-only; does not mutate any state.

The report includes all `show` fields plus:

- `goal` — free-text goal from campaign metadata, if set
- `verdict` — `all_shipped` (complete, every item has `outcome: shipped`), `complete_with_issues` (complete, but some items did not ship), or `not_complete`
- `safetyToContinue` — `can_start`, `can_resume`, `running`, `needs_approval`, `stale`, or `terminal`
- `dirtyGitState` — `git status --porcelain` output from the campaign's `projectDir`, or `null` if clean
- `groupings` — items bucketed by outcome: `shipped`, `blocked`, `held`, `skipped`, `failed`
- `nextOperatorAction` — narrative next step for the operator
- Per-item: a `commit` field (the ticket's `closed_commit` for shipped items) and null placeholders for `branch`, `worktreePath`, `prUrl`, `verificationState`, `doneAuditState`, `reviewerResult`

**Fields not yet populated:** `branch`, `worktreePath`, `prUrl`, `verificationState`, `doneAuditState`, and `reviewerResult` are always `null` — the source systems (worktrees, done-audit, reviewer) are not yet built (FG-382/383/384). These fields are present in the JSON shape now so dashboards and orchestrators can consume a stable schema from day one. A shipped item's `commit` is populated from the ticket's `closed_commit`.

The `--json` shape is stable for future dashboard and orchestrator use.

Example: `forge campaign report camp-abc123` after a completed campaign prints groupings and a verdict of `all_shipped` or `complete_with_issues`.

### Pause

`forge campaign pause <id> [--json]` requests a cooperative pause of a running campaign.

**Cooperative semantics:** pause does NOT interrupt an in-flight item. The live driver (`forge campaign start` or `forge campaign resume` process) finishes the current item, then checks campaign status before dispatching the next one. If the campaign is now `paused`, the driver stops without starting the next item and exits cleanly with stop reason `paused`.

Only a `running` campaign can be paused. Calling `pause` on any other status exits non-zero with the actual current status.

With `--json`:

```json
{
  "campaignId": "camp-abc123",
  "status": "paused",
  "note": "pause takes effect between items; the current item finishes first"
}
```

### Resume

`forge campaign resume <id> [--project <dir>] [--json]` resumes a paused campaign and **blocks until the campaign reaches `paused`, `failed`, or `complete`** — exactly like `forge campaign start`.

Before re-entering the dispatch loop, `resume` runs the same preconditions as `start`:

1. Campaign must be in `paused` status.
2. `approved_plan_hash` must be set.
3. The current plan hash (re-resolved from stored `sourceInput`) must match `approved_plan_hash`. If the backlog changed since approval, `resume` refuses with `stale_plan` — re-plan and re-approve are required.
4. `paused → running` transition succeeds via a CAS guard, preventing two concurrent `resume` calls from double-dispatching.

The driver then skips already-completed items and dispatches only remaining `pending` items.

`--project <dir>` is verify-only: the resolved path must equal the stored `projectDir` or `resume` refuses. It does not override the execution directory.

**Important:** only a `paused` campaign can be resumed. A campaign stuck in `running` after a process crash is not the same as paused — see crash recovery above.

Resume stop reasons:

| Stop reason | Meaning | Fix |
|---|---|---|
| `not_paused` | Campaign is not paused | Check status with `forge campaign show <id>` |
| `abandoned` | Campaign is abandoned (terminal) | No recovery |
| `no_project_dir` | Campaign predates `projectDir` capture | Re-plan with `forge campaign plan` |
| `invalid_project_dir` | Stored `projectDir` missing or has no backlog | Restore directory or re-plan |
| `not_approved` | `approved_plan_hash` not set | Run `forge campaign approve <id> --rationale <text>` |
| `stale_plan` | Plan changed since approval | Re-plan and re-approve |
| `already_running` | Concurrent `resume` won the CAS | Wait or investigate |
| `paused` | Driver stopped cooperatively | Run `forge campaign resume` again |
| `complete` | All items processed | None |
| `item_failed` | An item failed — campaign is now `failed` | Investigate and re-plan or abandon |

### Abandon

`forge campaign abandon <id> [--json]` moves a campaign to the terminal `abandoned` state. Irreversible.

Any `planned`, `running`, or `paused` campaign can be abandoned. Abandoning a `running` campaign takes effect cooperatively with the driver — the in-flight item completes before the driver stops, but the campaign status transitions to `abandoned` immediately.

`complete`, `failed`, and `abandoned` campaigns cannot be abandoned (they are already terminal). The command exits non-zero with the current status.

With `--json`:

```json
{ "campaignId": "camp-abc123", "status": "abandoned" }
```
