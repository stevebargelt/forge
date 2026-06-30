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

A decision point at the end of a phase. Three kinds: `human` (waits for `forge gate <task-id> advance`), `verdict` (passes if all reds pass; blocks on any authoritative-red fail; an authoritative shipping-reviewer that returns inconclusive also blocks — see [Blocked by red](#blocked-by-red)), and `auto` (advances on completion with no human input).

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

A task status signaling that a phase cannot advance without explicit human override. Two conditions set it:

1. **Authoritative-fail**: an authoritative red returned `fail` and the phase had `gate_on_verdict: true`.
2. **Shipping-reviewer inconclusive (FG-420)**: the authoritative shipping-reviewer returned `inconclusive` — from a `needs_human` verdict, an unrecognized verdict field, or a reviewer that failed to produce a verdict (pre-fail on required missing context). Forge persists a synthetic high-severity human-decision finding so the block reason is durable in the verdict record.

The CLI surfaces a `BLOCKED` state with the red's findings; the human cannot advance through the normal gate. Override requires `forge gate <task-id> advance --force --rationale "..."`. The shipping-reviewer inconclusive block is applied during red ingestion (not by the gate.ts aggregation, which is unchanged) and can only be resolved via explicit operator override.

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

## Readiness

A mechanical preflight that classifies a backlog item as ready for implementation before any work starts. Run via `forge readiness <ticket-id> [--project <dir>] [--json]`. Read-only — does not write to the project.

**Outcomes:**

| Outcome | Criteria |
|---|---|
| `ready` | Ticket has a `## Problem` section, a `## Goal` section (or `## Expected behavior`), and an `## Acceptance Criteria` section with at least one bullet point. |
| `needs_refinement` | One or more of the above sections is missing, or Acceptance Criteria exists but has no bullet points. The command emits a concrete `refinementProposal` rather than leaving the operator to guess what to add. |
| `blocked` | Ticket `status` is `blocked`. |
| `exploratory` | Ticket type is `idea`, or the title or body contains any of: spike, research, explore, exploratory, exploration, investigation. Lighter criteria apply — at least one of Problem or Goal must be present; Acceptance Criteria are not required. If both Problem and Goal are absent the outcome is still `exploratory`, but `gaps` and `refinementProposal` are populated with guidance. |

This is a **cheap structural checklist** — it checks whether the required sections exist and contain content. It is not an LLM reviewer and does not assess whether the content is correct or complete. The mechanical done audit — which checks shipping evidence such as git state, closed commit, and host verification — is a separate evaluator; see [Done audit (mechanical)](#done-audit-mechanical) below. Semantic quality review is the Shipping Reviewer (FG-384) — a separate opt-in agent; see [Shipping Reviewer](#shipping-reviewer) below.

**Scope boundary:** the evaluator checks structural completeness only. Whether the latest operator instruction has been reflected in the ticket body is the **orchestrator's responsibility** — the preflight has no access to the operator conversation and cannot verify that reconciliation.

With `--json` the output is a stable object:

```json
{
  "ticketId": "FG-42",
  "outcome": "needs_refinement",
  "gaps": ["Missing Goal section (or Expected behavior)", "Acceptance Criteria section has no bullet points"],
  "refinementProposal": "Add a ## Goal section (or ## Expected behavior) describing what success looks like. Add an ## Acceptance Criteria section with testable bullet points."
}
```

`refinementProposal` is `null` when outcome is `ready`, or when outcome is `exploratory` and at least one of Problem or Goal is present. For `blocked` and `needs_refinement` it is always non-null; for `exploratory` with both sections absent it is also non-null.

**Campaign integration (FG-413).** The readiness evaluator is wired into the campaign runner as a pre-dispatch gate. Before dispatching each pending item the runner evaluates the ticket; if the outcome is `needs_refinement` or `blocked`, the item is held without dispatching any implementation work — no engineer tokens are spent on an unready ticket. The item is recorded with `outcome: held`, `blockerKind: readiness`, `reason: "held because not ready: <gaps>"`, and `requestedHumanAction: "refine <ticketId> then resume — <refinementProposal>"`. Tickets that evaluate as `ready` or `exploratory` proceed to dispatch normally.

On `forge campaign resume`, items held with `blockerKind: readiness` are re-evaluated against the **current** ticket body. A ticket refined to `ready` or `exploratory` is released and dispatched; a ticket still not ready stays held and the campaign stays paused.

Example: `forge readiness FG-42` on a story that has a Problem section but no Acceptance Criteria returns `outcome: needs_refinement` with a `refinementProposal` explaining what to add.

## Done audit (mechanical)

A pure mechanical evaluator that checks whether a campaign item can truthfully be treated as shipped and done. Run automatically by `forge campaign report` for each campaign item (best-effort; `doneAuditState` is `null` only if collection throws or `projectDir` is missing). Not the LLM Shipping Reviewer (FG-384) — makes no subjective judgment; all evidence arrives as structured input.

**Result shape:**

```json
{
  "outcome": "pass" | "fail" | "unknown",
  "checks": [{ "name": "...", "status": "pass" | "fail" | "unknown", "detail": "..." }],
  "gaps": ["..."],
  "requestedAction": "..." | null
}
```

**Checks** (run in this order):

| Check | What it verifies |
|---|---|
| `ticket_closed` | Ticket `status` is `done` |
| `closed_commit_present` | Ticket has a `closed_commit` field |
| `commit_exists` | The closed commit exists in the repository |
| `clean_git` | Working tree is clean (`git status --porcelain` empty) |
| `pushed` | The closed commit is reachable from a remote branch |
| `container_verification` | Sum of `tests_run` across the campaign item's run tasks (INFORMATIONAL — excluded from outcome aggregation) |
| `host_verification` | Host typecheck + full suite passed and recorded |
| `deferral_linked` | If the ticket body declares deferred scope, a follow-up ticket is linked |

**Aggregation semantics.** `container_verification` is informational — present in `checks` but excluded from outcome aggregation. All other checks are required.

- `pass` — every required check is `pass`
- `fail` — at least one required check is a definite `fail`
- `unknown` — no required check is `fail`, but at least one required check is `unknown`

Missing evidence is always `unknown`, never `pass`. The `pushed` check follows this same principle when no remote is configured: `git remote` is checked first; if no remote exists, `pushed` resolves to `unknown` (not `fail`) — the commit's push status is unknowable without a remote. `container_verification` is populated from the campaign item's run task results — it sums `tests_run` across those tasks: `pass` when the sum is greater than zero, `fail` when the sum is exactly zero (zero container tests recorded), and `unknown` when the item has no run or no task recorded a numeric `tests_run`. It is informational and does **not** satisfy `host_verification`. `host_verification` resolves from the host-verification store: `pass` when matching pass evidence exists (any-fail-wins across multiple rows), `fail` when matching fail evidence exists, `unknown` when no matching evidence exists. The matching key is `(ticketId, projectDir, commitSha, gateName)`; evidence for a different commit, gate, project, or ticket is treated as absent. See [Recording host-verification evidence](#recording-host-verification-evidence) below.

**`requestedAction`** is `null` only when `outcome: pass`. Otherwise it names the concrete operator step(s) for each non-pass required check, joined with `"; "` — for example: `"run host typecheck + full suite, record the result, then re-audit"`, `"commit or revert the working tree"`, `"push <commit>"` (or `"no remote configured; push/PR unavailable"` when the `pushed` check is `unknown` due to no remote being configured), `"file a follow-up ticket and link it"`.

Example: `forge campaign report camp-abc123 --json` — the `doneAuditState` field on each item contains the result of running all eight checks against that item's ticket and git state.

### Recording host-verification evidence

`forge record-host-verification --ticket <id> --project-dir <path> --commit <sha> --command <cmd> --exit-code <n>` records a real host-command result in the host-verification store (`~/.forge/forge.db`). The collector reads this store when assembling done-audit input for `forge campaign report`.

Required flags:

| Flag | Description |
|---|---|
| `--ticket <ticketId>` | Ticket ID (e.g. `FG-419`) |
| `--project-dir <path>` | Absolute path to the project directory |
| `--commit <sha>` | Commit SHA that was verified (must match the ticket's `closedCommit`) |
| `--command <cmd>` | The exact command that was run |
| `--exit-code <n>` | Exit code of the command (`0` = pass, non-zero = fail) |

Optional: `--gate <name>` overrides the `gate_name` recorded for this evidence row; when omitted, `gate_name` defaults to the `--command` value. `--run-id <id>` associates the record with a forge run.

**Gate labeling and `host_verification`.** Two distinct defaults — do not conflate them. The **CLI `--gate` default** is the `--command` string. The **collector's required host gate default** is `"npm run test:all"` (per-project override via `.forge/config.json` `requiredHostGate`); `host_verification` passes only when a recorded `gate_name` matches this required gate. Consequence: `--command "npm run test:all"` without `--gate` records `gate_name = "npm run test:all"` and satisfies `host_verification`. A weaker command (e.g. `--command "npm run typecheck"`) without `--gate` records `gate_name = "npm run typecheck"` — supporting evidence only, which does not satisfy `host_verification`. An explicit `--gate "npm run test:all"` is the auditable operator choice to label an evidence row as the required gate; this closes a spoofing hole where a weak command could previously be auto-labeled as the required gate.

**Trust model.** Evidence is an audit trail in a trusted-operator context, not tamper-proof: `--command` and `--exit-code` record what was run and what it returned rather than an unverifiable bare assertion. The threat boundary is the operator — they control the host and could supply any exit code, but the recorder requires an explicit real-command invocation.

**Matching semantics.** The collector matches on all four dimensions: `ticketId`, `projectDir`, `commitSha`, and `gateName`. Evidence for a different commit, gate, project, or ticket does not satisfy `host_verification` — stale evidence resolves to `unknown`, never `pass`.

Example: after `npm run test:all` exits 0 on commit `abc1234` for ticket `FG-419`:

```shell
forge record-host-verification \
  --ticket FG-419 \
  --project-dir /code/forge \
  --commit abc1234 \
  --command "npm run test:all" \
  --exit-code 0
```

## Shipping Reviewer

An acceptance reviewer (agent role `shipping-reviewer`) that runs as a red at the end of a workflow phase when the workflow explicitly lists it in `reds`. The Shipping Reviewer evaluates whether the engineer's implementation satisfies the original product and technical requirements — acceptance in the production call path, not style, lint, or tests in isolation.

**Default-workflow adoption (FG-418 → FG-420).** The `feature` workflow's `build` phase lists `shipping-reviewer` as `authority: authoritative`, `gate_on_verdict: true`. It runs on every `feature` build and its verdict gates the phase: a `needs_fix` or an inconclusive result (`needs_human`, an unrecognized verdict, or a reviewer that failed to produce a verdict) blocks the gate (`blocked_by_red`); a clean `ship` or a fully-linked `ship_with_named_deferrals` advances it. FG-418 introduced the wiring as advisory (`authority: specialist`, `gate_on_verdict: false`); FG-420 promoted it to authoritative once FG-419 host-verification evidence and FG-367 git/push truth were real prerequisites. Other workflows still do not list `shipping-reviewer` in their reds.

FG-381, FG-383, FG-384, FG-418, and FG-420 shipped the role, the Reviewer Context Packet, the verdict-mapping, the default-workflow wiring, and the authoritative promotion.

### Reviewer Context Packet

Before the Shipping Reviewer is dispatched, the orchestrator assembles a `ReviewerContextPacket` from live run state and passes it as `inputs.reviewerContextPacket`. If required context is missing, the agent is pre-failed rather than dispatched with incomplete inputs.

Fields:

| Field | Type | What it carries |
|---|---|---|
| `backlog` | `{id, title, type, status, body, acceptanceCriteria, nonGoals, parentEpic}` \| `null` | Structured backlog ticket resolved from `run.metadata.ticketId`. `null` — and a required `missingContext` entry — when the ticket id is absent or the ticket cannot be read |
| `operatorAsk` | `string` \| `null` | Rationale from the **last** human-advance gate; the operator's stated intent at the time they advanced the run. `null` — and a non-required `missingContext` entry — when no human-advance gate exists (known gap: FG-380) |
| `architectDecisions` | `unknown` \| `null` | Architecture-advisor task result; `null` when no completed architect task exists for the run |
| `techLeadPlan` | `unknown` \| `null` | Tech-lead task result; `null` when no completed tech-lead task exists for the run |
| `requestChangesHistory` | `Array<{taskId, rationale, decidedAt, verdictFindings}>` | Prior request-changes gates and their verdict findings, ordered chronologically by `decidedAt` |
| `redFindings` | `VerdictRow[]` | Verdicts from non-shipping-reviewer reds on the primary task — provided as context, not re-scored |
| `engineerSummary` | `unknown` \| `null` | Primary engineer task result |
| `git` | `{commitSha?, diffRange?, changedFiles, worktreePath?}` | Git state extracted from the engineer result |
| `verificationCommands` | `Array<{command, context: "host"\|"container"}>` | Commands the engineer ran or recommends for verification |
| `deferredScope` | `Array<{description, followUpTicketId?}>` | Scope items the engineer explicitly deferred; entries without `followUpTicketId` are unlinked |
| `doneAudit` | `DoneAuditResult` \| `null` | Mechanical done-audit result — see [`doneAudit` in the packet](#doneaudit-in-the-packet) below |
| `missingContext` | `Array<{field, reason, required}>` | Gaps the reviewer should account for; entries with `required: true` block dispatch |

**Engineer evidence at review time.** The `engineerSummary`, `git`, `verificationCommands`, and `deferredScope` fields populate at review time from the in-hand primary task result (FG-418) — previously they were hollow because the DB `task.result` is `null` until after reds have run. For a fanout `build` phase, the evidence is aggregated from the fanout child tasks: `git.changedFiles` is the union of all children's `files_modified`; `verificationCommands` and `deferredScope` are accumulated across all children; `engineerSummary` contains the array of child results; `git.commitSha` and `git.diffRange` are taken from the last completed child that provided them.

**Pre-fail on required missing context.** If any `missingContext` entry has `required: true`, the shipping-reviewer task is pre-failed with a descriptive error and excluded from dispatch — no agent call is made. Currently `backlog` is the only required field. `operatorAsk` is non-required — its absence is surfaced to the agent but does not block dispatch.

### `doneAudit` in the packet

The `doneAudit` field carries the mechanical done-audit result (shape: `{outcome: "pass"|"fail"|"unknown", checks: [...], gaps: [...], requestedAction}`). See [Done audit (mechanical)](#done-audit-mechanical) for check definitions and aggregation semantics.

**`host_verification` in the packet.** The collector reads matching evidence from the host-verification store when the ticket has a `closedCommit`. Matching pass evidence → `hostVerified: true`; matching fail evidence → `hostVerified: false`; no matching evidence → `hostVerified: null` (unknown). The `host_verification` check's `detail` field carries `gate`, `command`, `exit_code`, `commit`, and `recorded_at` from the evidence row. `doneAudit.outcome: "pass"` is reachable for real items once matching host-verification evidence has been recorded via `forge record-host-verification` (see [Recording host-verification evidence](#recording-host-verification-evidence)).

The Shipping Reviewer seed instructs the agent that a failing or unknown done-audit blocks `ship` unless the agent records an explicit exception in `doneAuditDisposition`. The mapper enforces this mechanically via the guardrail backstop (see [Verdict mapping](#verdict-mapping) below).

### Verdict vocabulary

The Shipping Reviewer emits a **rich verdict** — distinct from the `pass / fail / inconclusive` vocabulary used by other reds:

| Verdict | Meaning |
|---|---|
| `ship` | Every acceptance criterion is met in the production call path; no unresolved prior findings; done-audit is resolved or explicitly excepted in `doneAuditDisposition` |
| `ship_with_named_deferrals` | Shippable except for explicitly deferred scope. `named_deferrals` **must** contain at least one entry, and every entry **must** have both a non-empty `description` and a non-empty `followUpTicketId` — an empty array or any unlinked deferral is not valid; the mapper treats it as `needs_fix` |
| `needs_fix` | At least one required acceptance criterion is unmet in the production call path, or a prior request-changes finding is unresolved |
| `needs_human` | The agent cannot decide: ambiguous requirement, conflicting operator intent, or missing context not resolved by the packet |

Full rich-verdict output contract (the agent seed):

```json
{
  "status": "complete",
  "verdict": "ship | ship_with_named_deferrals | needs_fix | needs_human",
  "confidence": 0.0,
  "named_deferrals": [{ "description": "...", "followUpTicketId": "FG-123" }],
  "doneAuditDisposition": "ok | accepted_exception: <reason> | covered_by_deferral",
  "findings": [
    {
      "severity": "high | medium | low",
      "summary": "...",
      "cites": "acceptance_criterion | operator_instruction | design_decision | risk_invariant",
      "evidence": "...",
      "file": "src/path/to/file.ts",
      "line": 42
    }
  ],
  "invariants_verified": ["AC 1: met | unmet | deferred"]
}
```

### Verdict mapping

`mapShippingReviewerVerdict` translates the agent's rich verdict into forge's internal `pass / fail / inconclusive`:

| Agent verdict | Maps to | Condition |
|---|---|---|
| `ship` | `pass` | Subject to guardrail backstop (see below) |
| `ship_with_named_deferrals` | `pass` | `named_deferrals` has at least one entry AND every entry has a non-empty `description` AND a non-empty `followUpTicketId` |
| `ship_with_named_deferrals` | `fail` | `named_deferrals` is empty, or any entry is missing `description` or `followUpTicketId` |
| `needs_fix` | `fail` | Unconditionally |
| `needs_human` | `inconclusive` | Unconditionally |
| absent / unrecognized | `inconclusive` | Malformed or missing verdict field |

**Guardrail backstop.** A mapped `pass` (from `ship`) is downgraded to `fail` when the packet contains a done-audit result with `outcome: "fail"` or `"unknown"` AND the agent's `doneAuditDisposition` is neither `"accepted_exception: ..."` nor `"covered_by_deferral"`. This prevents the agent from accepting a ship verdict over unresolved mechanical audit checks without explicitly recording a waiver.

### Fail-loud / missing-context precondition

Forge's red-ingestion pipeline downgrades a `fail` verdict with no surviving well-formed graded finding to `inconclusive` (see [Verdict](#verdict)). A `fail` that carries no real finding has no case — it cannot block the gate.

To prevent this from silently neutralizing a legitimate block, the mapper unconditionally attaches a well-formed synthetic finding to **every mapper-decided `fail`**, regardless of what the agent's own findings contain:

- **`needs_fix` path**: a synthetic high-severity finding anchors the fail so it survives `gradeFindings` even when the agent returned no findings or only malformed ones.
- **Invalid-deferral path**: a synthetic finding records the specific deferral violation (`ship_with_named_deferrals` with a missing `description` or `followUpTicketId`).
- **Guardrail backstop path**: a synthetic finding records the done-audit outcome and disposition that triggered the downgrade.
- **Authoritative `needs_human` / unrecognized path (FG-420)**: when the shipping-reviewer runs as `authority: authoritative` with `gate_on_verdict: true` and the mapped verdict is `inconclusive` (from `needs_human` or an unrecognized verdict field), a synthetic high-severity finding is prepended before the verdict is persisted. The stored verdict remains `inconclusive` — distinguishing a human-gate block from a genuine failure — but `authoritativeFail` is set, so the primary task transitions to `blocked_by_red`. The operator must run `forge gate --force --rationale` to override.

Without this unconditional substantiation, a `needs_fix` from the Shipping Reviewer could silently neutralize to `inconclusive` if the agent's findings were absent or malformed — and the reviewer would fail to block.

Example: a workflow wired to include `shipping-reviewer` in a phase's `reds` dispatches the agent with a `ReviewerContextPacket`. The agent returns `needs_fix` with no findings; the mapper attaches a synthetic high-severity finding before grading, so the fail survives and blocks the gate.

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
| `plan_unresolvable` | The plan can no longer be resolved from stored `sourceInput` — a source ticket may have been deleted from the backlog since planning | Re-plan with `forge campaign plan` |
| `dry_run_not_executable` | Campaign mode is `dry_run` — plan-and-report only; `start` refuses to dispatch any work or mutate the repo | Re-plan with `--mode pilot` or `--mode sequential` and re-approve |
| `recovery_needed` | One or more campaign items are in a non-terminal, non-pending state (`running`, `awaiting_gate`, `awaiting_red`, `blocked_by_red`, or similar) — campaign stays `planned`, no dispatch occurs | Inspect the stuck item with `forge campaign show <id>` (the `Next action` line names the ticket and its `run_id`); reset the item to `pending` or mark it `failed` (manual DB operation — see crash recovery below), then start again |
| `already_running` | A `planned → running` CAS in the database rejected the transition — another `start` process already holds it | Wait or recover — see crash recovery below |

**Important:** `forge campaign plan` defaults to `--mode dry_run`. A `dry_run` campaign is plan-and-report only — `forge campaign start` will refuse it with `dry_run_not_executable`. To actually execute a campaign, plan with `--mode pilot` or `--mode sequential` and re-approve before starting.

If all preconditions pass, the campaign transitions to `running` via a compare-and-swap (CAS) and items execute **strictly one at a time** through the engineer agent. For each item a `run_id` is pre-allocated and persisted **before** dispatch — this is the crash evidence trail.

**Outcome semantics.** After an item's engineer task completes:

- The item is marked `outcome: shipped` only if the backlog ticket is `status: done` with a `closed_commit`. A completed agent task alone is never treated as shipped.
- If the ticket is done but lacks a `closed_commit`, the outcome is left unset.
- If the task fails, the runner classifies the failure as SHARED or LOCAL and applies the blocker/continue policy — see [Blockers and continuation](#blockers-and-continuation) below.

**`--project` is verify-only.** If `--project <dir>` is provided, `start` checks that the resolved path equals the campaign's stored `projectDir` and refuses if they differ. It does **not** override the execution directory — the campaign always runs against the `projectDir` captured at plan time. Run `forge campaign start` from the same project root used for `forge campaign plan`, or pass `--project` pointing at that same root.

Example: `forge campaign start camp-abc123 --project ~/code/my-app` verifies the stored directory, then starts executing items sequentially.

### Blockers and continuation

**Readiness gate (pre-dispatch).** Before any engineer work is started for a pending item, the runner evaluates the ticket's readiness. If the outcome is `needs_refinement` or `blocked`, the item is held immediately — `lifecycleStatus: pending`, `outcome: held`, `blockerKind: readiness`, `continuePolicy: hold_dependents`. No run is created and no implementation tokens are spent. This is distinct from task-failure blockers below; the campaign transitions to `paused` when all items are processed and held items remain. When `forge campaign start` exits with `stopReason: paused`, the human output selects a message by item state in this branch order:

1. **Readiness-held** (one or more items have `outcome: held`, `blockerKind: readiness`): `campaign paused — N item(s) not ready: refine <ids> then resume`
2. **Dependency-held** (one or more items have `outcome: held` with no `blockerKind` — held because a `related` LOCAL item is still blocked; the branch filter is `blockerKind !== "readiness"`, which `undefined` satisfies; these items carry a `reason` string that the message displays, but `reason` is not part of the filter): `campaign paused — N item(s) held pending an unresolved blocker: <ids> (<reason> when a single item); resolve the blocker (see forge campaign show/report) then resume`
3. **Blocked** (one or more items have `outcome: blocked`): `campaign paused — N item(s) blocked; resolve and resume`
4. **Otherwise** (cooperative/operator-requested pause between items, no held or blocked items): `campaign paused between items — run resume to continue`

Reason string operators will see: `"held because not ready: <gaps>"`, e.g. `"held because not ready: Missing Problem section; Missing Acceptance Criteria section"`. The `requestedHumanAction` is: `"refine <ticketId> then resume — <refinementProposal>"`.

**Task-failure blockers.** When an item's engineer task fails, the runner classifies the failure as either SHARED (system-level) or LOCAL (agent-level) and applies a conservative hold/continue policy.

**SHARED blockers hold the whole campaign.** System-level failures indicate a condition that would affect every remaining item. The campaign transitions to `paused` (resumable) and all remaining items stay `pending`. Fix the shared issue, then run `forge campaign resume`.

SHARED blocker kinds: `auth`, `infrastructure`, `git_state`, `dependency`, `merge_conflict`, `campaign_system`. This covers auth missing/expired/injection-failed, container crash/orphan/idle timeout, malformed or missing result, git state, dependency install, merge conflict, and thrown dispatch errors (classified as `infrastructure`).

**LOCAL blockers apply the dependency policy.** When the agent ran but could not complete the ticket (scope, acceptance, or its own tests), the failure is LOCAL. The runner records the blocked item (`lifecycleStatus: failed`, `outcome: blocked`, `blockerKind`, `continuePolicy`, `reason`, `requestedHumanAction`) and then evaluates each remaining `pending` item against the blocked item using the ticket's `related` metadata only — no deeper inference:

| Relation | Sequential mode | Pilot mode |
|---|---|---|
| DEPENDENT — either ticket's `related` field lists the other | HELD | HELD |
| UNKNOWN — blocked ticket has no `related` metadata | HELD | CONTINUES (visible risk) |
| INDEPENDENT — blocked ticket has `related` metadata, but it does not include the later ticket | CONTINUES | CONTINUES |

A held item keeps `lifecycleStatus: pending` with `outcome: held`, `continuePolicy: hold_dependents`, and an exact reason string. Held items are preserved, never silently skipped.

Reason strings operators will see:
- `"held because not ready: <gaps>"` — readiness-held (`blockerKind: readiness`)
- `"held because related to blocked item FG-xxx"` — dependency-held
- `"held because dependency relation is unknown in sequential mode"` — dependency-held
- `"continued because relation unknown and mode=pilot"`
- `"continued because related metadata does not link to blocked item"`

**Pilot mode** overrides the UNKNOWN relation only — pilot never continues past a KNOWN dependency and never overrides a SHARED blocker.

**Campaign end-state after all items are processed:**
- Any held items present → campaign transitions to `paused` (awaiting resume). `forge campaign show` and `forge campaign report` surface held items with their reasons and a `Next action` pointing to the blocking item.
- No held items → campaign transitions to `complete`.
- A completed campaign with any blocked, held, or skipped items, or where any shipped item's done-audit is not `outcome: pass`, reports `verdict: complete_with_issues`, never `all_shipped`.

**Resume reconsiders held items.** When `forge campaign resume` re-enters the dispatch loop it handles held items by kind. Readiness-held items (`blockerKind: readiness`) are re-evaluated against the current ticket body — released to dispatch once the ticket is `ready` or `exploratory`, kept held otherwise. Dependency-held items are re-evaluated against the rebuilt set of still-blocked LOCAL items — released when their blocker is resolved, kept held otherwise. `resume` does not retry the failed/blocked item itself.

### Crash recovery (MVP limitation)

`forge campaign start` holds its process for the campaign's entire duration, which may span several hours or overnight. **Crash recovery is not automated in this MVP.** If the `start` process dies mid-run (crash, SIGKILL, power loss):

- The campaign stays stuck in status `running`.
- A subsequent `forge campaign start` refuses with stop reason `not_planned`.
- Recovery evidence is durable: each item's `run_id` is persisted before dispatch. Run `forge campaign show <id>` to see which item was in flight when the process died.

**Note:** `forge campaign resume` only operates on a `paused` campaign. A campaign stuck in `running` after a process crash is not the same as paused — no automated recovery path exists yet; manual database intervention is still required.

**In-flight items are a hard block on both `start` and `resume`.** If the campaign is reset to `planned` (below) but the item is still in a non-terminal, non-pending state, `forge campaign start` refuses with `recovery_needed` and the item must be reset too before any work is dispatched. The same guard applies to `forge campaign resume` on a `paused` campaign — if an item was mid-flight when the driver died or the campaign was paused, `resume` refuses with `recovery_needed` rather than continuing or completing over the unfinished item. Use `forge campaign show <id>` to identify the stuck item: the `Next action` line names the ticket id, its current lifecycle status, and the `run_id` to inspect. Reset the item in the DB before retrying.

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

For a `paused` campaign with a stuck item (no campaign status reset needed — the campaign is already `paused`), run only the second statement, scoping it to the stuck item's status. After the item is reset, `forge campaign resume` will proceed normally.

Before re-starting or resuming, inspect the run that was in flight (using the persisted `run_id`) to determine whether the engineer agent finished before the crash. If the ticket reached `status: done` with a `closed_commit`, mark the item complete manually rather than re-dispatching the same work.

### Campaign lifecycle

Campaigns move through a fixed set of statuses. Control commands enforce legal transitions and refuse others with a clear error message and non-zero exit.

| From | To | Command |
|---|---|---|
| `planned` | `running` | `forge campaign start` |
| `planned` | `abandoned` | `forge campaign abandon` |
| `running` | `paused` | `forge campaign pause` (cooperative), or automatic on SHARED blocker, or automatic when all items processed with held items remaining |
| `running` | `complete` | automatic (all items processed, no held items) |
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
- Per-item rows: ticket id, title, lifecycle status, outcome, blocker kind, run id, reason, and `requestedHumanAction` (rendered as `action: <text>` when set). For items whose readiness outcome is `needs_refinement` or `blocked`, or that are readiness-held (`outcome: held`, `blockerKind: readiness`), the human text also prints the readiness outcome, gaps (`;`-delimited, omitted when empty), and refinement proposal on separate indented lines. (`continuePolicy` is present in the JSON item rows but is not rendered in human text.) For failed/blocked items `blockerKind`, `reason`, and `requestedHumanAction` are populated; for readiness-held items `blockerKind` is `readiness` and `requestedHumanAction` is `"refine <ticketId> then resume — <refinementProposal>"`; for dependency-held items `outcome` is `held` with a `reason` explaining which blocker triggered the hold. The `readiness` field (`{ outcome, gaps, refinementProposal }` evaluated live from the current ticket body; `null` when the ticket cannot be read) is present in both `show` and `report` item JSON.
- A `Next action` line with the recommended operator step (`approve`, `start`, `resume`, `complete — none`, etc.). When a readiness-held item is the only hold, the line reads `refine <ticketId> then resume`; when a failed/blocked item needs resolution first, the line reads `resolve blocker <ticketId> (<blockerKind>) then resume`. When any campaign item is in an in-flight state and the campaign is `paused` (or `running` with a non-running in-flight item), the line instead reads: `recovery needed: item <ticket-id> is <lifecycle-status> (run <run-id>) — inspect the run; reset the item to pending or mark it failed before resuming`. When the source plan can no longer be resolved (e.g. a source ticket was deleted from the backlog since planning), the line reads: `plan can no longer be resolved (a source ticket may have been deleted) — re-plan with forge campaign plan`. Both `show` and `report` render the full persisted campaign and item state without error in this case; `start` and `resume` refuse non-zero with stop reason `plan_unresolvable`.

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
      "requestedHumanAction": null,
      "readiness": { "outcome": "ready", "gaps": [], "refinementProposal": null }
    }
  ],
  "nextAction": "resume"
}
```

Use `forge campaign show` for a quick status check; for a full checkpoint report use `forge campaign report`.

### Report

`forge campaign report <id> [--json]` generates a checkpoint or final campaign report. Read-only; does not mutate any state.

The report JSON has a distinct shape from `show`: it omits `planStale`, `projectDir`, and `activeItem`, and uses `nextOperatorAction` instead of `nextAction`. Fields emitted:

- `campaignId`, `status`, `mode`, `approvedPlanHash`, `currentPlanHash` — same semantics as `show`
- `sourceInput` — the raw source input recorded at plan time (`{kind, ticketIds}` / `{kind, epicId}` / `{kind, epicId, additions, exclusions}`)
- `goal` — free-text goal from campaign metadata, if set
- `verdict` — `all_shipped` (campaign status is `complete`, every item has `outcome: shipped`, AND every item's done-audit result is `outcome: pass`; requires matching host-verification evidence recorded via `forge record-host-verification` for each shipped item), `complete_with_issues` (campaign status is `complete`, but one or more items did not ship, or all shipped but at least one done-audit result is not `outcome: pass`), or `not_complete` (campaign is not yet complete)
- `safetyToContinue` — `can_start`, `can_resume`, `needs_resolution`, `dry_run_not_executable`, `running`, `needs_approval`, `stale`, `recovery_needed`, or `terminal`. `needs_resolution` means operator intervention is required before the campaign can resume — either a failed/blocked item (`lifecycleStatus: failed`, `outcome: blocked`) must be resolved, or an unrefined readiness-held item (`lifecycleStatus: pending`, `outcome: held`, `blockerKind: readiness`) must be refined; `can_resume` means neither condition is present. `dry_run_not_executable` means the campaign is in `dry_run` mode and cannot be started. `stale` covers two conditions: the plan hash changed since approval (`stale_plan`), or the plan can no longer be resolved at all because a source ticket was deleted from the backlog since planning (`plan_unresolvable`) — both require re-plan and re-approve. `recovery_needed` is returned when a campaign has an item in a non-terminal, non-pending in-flight state; `forge campaign resume` will refuse until the item is reset manually.
- `dirtyGitState` — `git status --porcelain` output from the campaign's `projectDir`, or `null` if clean
- `groupings` — items bucketed by outcome: `shipped`, `blocked`, `held`, `skipped`, `failed` (items with `outcome: needs_refinement` are counted in `failed`)
- `deferredScope` — always `[]` (reserved)
- `followUpTickets` — always `[]` (reserved)
- `nextOperatorAction` — narrative next step for the operator. On a `paused` campaign with a failed/blocked item, names the blocking ticket and its `blockerKind` (e.g. `resolve blocker FG-5 (git_state) then resume`); when blockers are resolved but a readiness-held item remains, prompts `refine <ticketId> then resume`; when blockers are resolved and only dependency-held items remain, prompts `resume — N held items will be reconsidered`. On a `complete` campaign where shipped items have unresolved done-audit gaps, names the concrete operator steps (e.g. `shipped items have unresolved done-audit gaps — run host typecheck + full suite, record the result, then re-audit`).
- Per-item: all show item fields (including `readiness` — see Show above), plus a `commit` field (the ticket's `closed_commit` for shipped items), `doneAuditState` (see below), `hostVerificationDetail` (the `detail` string from the `host_verification` check in `doneAuditState` when evidence was recorded, `null` otherwise), `branch` and `worktreePath` (populated when the campaign item ran in a Forge-managed worktree — see [Git discipline (v1)](#git-discipline-v1); `null` otherwise), and null placeholders for `prUrl`, `verificationState`, `reviewerResult`. The human text rendering matches show: per item, `requestedHumanAction` is rendered as `action: <text>` when set, readiness outcome/gaps/refinementProposal are printed for items whose readiness is `needs_refinement` or `blocked` or that are readiness-held, the done-audit outcome is printed for each item (when outcome is not `pass`, gaps and `requestedAction` are also printed), and `branch=` and `worktree=` are appended to the item line when set.

**`doneAuditState`** is populated best-effort (null only when collection throws or `projectDir` is missing). Shape: `{ outcome: "pass" | "fail" | "unknown", checks: [{ name, status, detail? }], gaps: string[], requestedAction: string | null }`. See [Done audit (mechanical)](#done-audit-mechanical) for full check names and aggregation semantics.

**Fields not yet populated:** `prUrl`, `verificationState`, and `reviewerResult` are always `null` — no auto-push, no auto-PR, and the LLM reviewer result is not yet wired to campaign report items. `branch` and `worktreePath` are populated when a Forge-managed worktree was used for the item; see [Git discipline (v1)](#git-discipline-v1). A shipped item's `commit` is populated from the ticket's `closed_commit`.

The `--json` shape is stable for future dashboard and orchestrator use.

Example: `forge campaign report camp-abc123` after a completed campaign prints groupings and a verdict of `all_shipped` or `complete_with_issues`.

### Git discipline (v1)

Forge records git state it actually managed rather than claiming it managed state it did not. The v1 policy is conservative — truthful surfacing of local evidence, no automation that changes remote state.

**Branch and worktree recording.** When a campaign item runs in a Forge-managed worktree (enabled by the `FORGE_WORKTREES=1` environment variable), the executor records:

- `branch` — the worktree branch name, formatted as `forge/{runId}/{taskId}`.
- `worktreePath` — the absolute filesystem path of the worktree.

Both fields are `null` when the item ran without a worktree. Forge never sets these fields to imply it managed a branch it did not create.

**No auto-push, no auto-PR.** Forge does not run `git push` or open pull requests automatically in v1. The `prUrl` field on campaign report items is always `null`. Push and PR creation remain the operator's responsibility. Auto-push/PR is a later explicit opt-in and will never be hidden behavior.

**No-remote handling.** When no git remote is configured for the project, Forge cannot know whether the closed commit has been pushed. In this case the `pushed` done-audit check resolves to `unknown` rather than `fail` — the absence of a remote is not a failure, it is the correct state for a local-only project. The collector checks `git remote` before attempting `git branch -r --contains`; if no remote is listed, `pushed` stays `null` and the done-audit outcome follows the conservative unknown-means-not-pass rule. When the outcome is not `pass` and `pushed` is in this state, the `requestedAction` reads `"no remote configured; push/PR unavailable"` rather than `"push <commit>"` — the reason is derived at evaluation time, not a persisted field.

**No destructive git operations.** Forge never force-pushes, rewrites history, or deletes branches that contain work. All git operations performed by Forge are additive or read-only.

**Policy escape hatch.** Projects that never use worktrees (the default) are not affected — `branch` and `worktreePath` remain `null` and Forge makes no claim about the current branch. Dashboard and report output always reflects only what Forge directly observed.

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

`forge campaign resume <id> [--project <dir>] [--json]` resumes a paused campaign and **blocks until the campaign reaches `paused` or `complete`** — exactly like `forge campaign start`.

Before re-entering the dispatch loop, `resume` runs the same preconditions as `start`:

1. Campaign must be in `paused` status.
2. `approved_plan_hash` must be set.
3. The current plan hash (re-resolved from stored `sourceInput`) must match `approved_plan_hash`. If the backlog changed since approval, `resume` refuses with `stale_plan` — re-plan and re-approve are required.
4. No campaign item may be in an in-flight state (`running`, `awaiting_gate`, `awaiting_red`, `blocked_by_red`, or any other non-terminal/non-pending state). If any item is in flight, `resume` refuses with `recovery_needed` and leaves the campaign `paused` — the item must be reset manually (see crash recovery above) before resuming. This prevents silently completing a campaign over unfinished work.
5. `paused → running` transition succeeds via a CAS guard, preventing two concurrent `resume` calls from double-dispatching.

The driver then skips already-terminal items and re-evaluates held items by kind: readiness-held items (`blockerKind: readiness`) are re-evaluated against the **current** ticket body — released when the ticket is now `ready` or `exploratory`, kept held otherwise; dependency-held items are re-evaluated against the current blocked set — released when their blocker is resolved. Remaining `pending` items are dispatched in order.

When `forge campaign resume` exits with `stopReason: paused`, it applies the same four-way paused message as `forge campaign start` — readiness-held takes priority, then dependency-held, then blocked, then the generic between-items case. The only wording difference: the generic case reads `campaign paused between items — run resume again to continue` (vs. `run resume to continue` from `start`).

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
| `plan_unresolvable` | The plan can no longer be resolved from stored `sourceInput` — a source ticket may have been deleted from the backlog since planning | Re-plan with `forge campaign plan` |
| `recovery_needed` | One or more campaign items are in a non-terminal, non-pending state — campaign stays `paused`, no dispatch occurs | Inspect the stuck item with `forge campaign show <id>` (the `Next action` line names the ticket, its lifecycle status, and `run_id`); reset the item to `pending` or mark it `failed` (manual DB operation — see crash recovery above), then resume |
| `already_running` | Concurrent `resume` won the CAS | Wait or investigate |
| `paused` | Driver stopped cooperatively (SHARED blocker or held items remain) | Run `forge campaign resume` again after resolving any blocker |
| `complete` | All items processed | None |

### Abandon

`forge campaign abandon <id> [--json]` moves a campaign to the terminal `abandoned` state. Irreversible.

Any `planned`, `running`, or `paused` campaign can be abandoned. Abandoning a `running` campaign takes effect cooperatively with the driver — the in-flight item completes before the driver stops, but the campaign status transitions to `abandoned` immediately.

`complete`, `failed`, and `abandoned` campaigns cannot be abandoned (they are already terminal). The command exits non-zero with the current status.

With `--json`:

```json
{ "campaignId": "camp-abc123", "status": "abandoned" }
```
