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

Both commands hard-code "use the `forge backlog` CLI, do NOT read backlog files directly." The CLI is the bounded interface that protects orchestrator context cost; structured-format projects store notes at `backlog/notes.md` and tickets under `backlog/stories/`, while legacy projects use a single `BACKLOG.md`.

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
