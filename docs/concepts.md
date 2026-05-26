# Concepts

Glossary of forge terms. One paragraph each, with a concrete example from `run-litellm-eval`.

## Run

A single workflow invocation. Created by `forge new`, given a unique id like `run-litellm-eval-96a1da`. Recorded in the `runs` table with status `active` | `complete` | `abandoned`, plus the `projectDir` of the directory it was created from. SQLite is the resume state — a run that's parked at a gate survives reboots.

Example: `forge new investigation "litellm-eval" --question "Does LiteLLM solve provider routing?"` creates one run.

## Project

The directory mounted at `/project` in the agent container. Recorded on each run as `runs.project_dir`. Defaults to the cwd at `forge new` / `forge invoke` time; override with `--project <dir>`. Implementer agents see it read-write; red agents see it read-only at the OS level (FORGE-DEC-006).

Example: a run created via `cd ~/code/my-app && forge new feature "add login" --brief "..."` has `projectDir = /Users/you/code/my-app`. Every container spawned for that run mounts that path at `/project`.

## Workspace

The cwd of the human running `forge`. For most runs the workspace equals the project (you're in `~/code/my-app` and the run drives changes to `~/code/my-app`). They diverge when an orchestrator session in one directory drives runs against a different project — e.g. `~/code/audit-workspace` orchestrating runs whose `projectDir` is `~/code/forge`. `forge new` and `forge invoke` stamp the workspace into `metadata.workspace` (default: cwd; override with `--workspace`). `forge status` filters by workspace (matching either `projectDir == cwd` or `metadata.workspace == cwd`) by default; use `--all` to see runs across every project on the host.

## Orchestrator heartbeat

A liveness signal for the Claude Code session that's currently acting as a project's orchestrator. `forge init` installs three Claude Code session hooks (SessionStart / Stop / SessionEnd) into `<project>/.claude/settings.json`; those hooks invoke `scripts/claude-hooks/orchestrator-heartbeat`, which maintains a JSON file at `~/.forge/orchestrators/<session-id>.json` containing `{sessionId, projectDir, startedAt, lastSeen}`. SessionStart writes it, Stop touches `lastSeen` after every assistant turn, SessionEnd deletes it. A heartbeat whose `lastSeen` is within the last 15 minutes is considered live; older ones are stale (likely a crashed session). `forge projects list` shows live projects with a ● and floats them to the top.

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

A fixed step in a workflow. Phases run in order; each phase has one or more agent roles, an optional set of red agents, and a gate. Phases are defined in TypeScript files under `src/workflows/`.

Example: the investigation workflow has four phases — `frame`, `investigate`, `synthesize`, `recommend`.

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

An adversarial agent. Mounted **read-only** on the project at the OS level (not by prompt). Two stances: *wide* (generic disbelief, no specific failure mode) and *narrow* (anti-prompts derived from force-level constraints). Reds never see other panel members' findings or the blue's transcript.

Example: at `synthesize`, the narrow red caught that the architectural-implications section overweighted LiteLLM in the Pi-vs-Gas-City decision.

## Constraint

A markdown file under `~/.forge/constraints/` with frontmatter declaring `level` (`suggest` or `force`), `roles`, `workflows`, and optionally `phases`. Suggest-level constraints are appended to the agent's CLAUDE.md (Tier 3 of `composeSystemPrompt`). Force-level constraints feed the narrow red as anti-prompts; they never relax to suggestions.

Example: `atlas-stack-rn.md` is a force-level constraint that locks the frontend stack to React Native and surfaces as an anti-prompt for the narrow red.

## Blocked by red

A status that means: a red came back authoritative-fail and the phase had `gateOnVerdict: true`. The CLI surfaces a `BLOCKED` state with the red's findings; the human cannot advance through the normal gate. Override requires `forge gate <task-id> advance --force --rationale "..."`.

Example: a build phase whose red detected a stack violation would set the build task to `blocked_by_red` automatically.

## Container crash vs. agent failure

Two failure modes, surfaced differently. **Container crash**: container exited non-zero with no result JSON (Docker issue, OOM, credential failure). Event type `task.crashed`. **Agent failure**: container exited 0 and wrote a result JSON with `status: "failed"` and an error reason. Event type `task.failed`. Different follow-up actions.
