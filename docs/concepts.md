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

## Post-merge integration gate

Worktrees (FG-351/352/353) turn same-file textual races into detectable git conflicts, but they do not catch semantic cross-file breakage: agent A changes a signature in `foo.ts`, agent B (own worktree) still calls the old signature in `bar.ts` — the two branches touch no overlapping lines, so `git merge` succeeds cleanly with broken code merged and no signal. FG-357 closes that gap by building+testing the MERGED tree, not just merging it.

After a worktree branch merges cleanly — single-step merge-to-HEAD (FG-352) or fan-out integration-branch merge-to-HEAD (FG-353) — forge runs the project's own `npm run test:unit` script against the merged tree before the step is considered done. This runs on the host (the merge already landed on the host checkout; nothing container-specific is left to reproduce), reusing forge's own test entrypoint rather than a second test runner. If the project's `package.json` declares no `test:unit` script, the gate is a no-op (a project-config gap, not a merge defect, so it must not block every worktree merge).

A gate failure is a new terminal `failure_kind: integration_failed`, distinct from `merge_conflict`, with the build/test output attached to the task's error. It is non-retryable (retrying would re-dispatch against the same broken merge) — the recorded advice is to fix the break in code, or run `git reset --hard HEAD~1` in `run.projectDir` to undo the merge. On failure the task returns before any cleanup, so the merged worktree/branch stay retained for inspection — the same no-discard contract as `merge_conflict`. The default 10-minute timeout is overridable via `FORGE_INTEGRATION_GATE_TIMEOUT_MS` (milliseconds).

## Agent worktree dependency parity

Only on macOS hosts, and only when a task dispatches into a git worktree (worktree mode — FG-345/351), forge upgrades the container-local `node_modules` shadow (`#245`, darwin-only, exists to keep every dependency write inside the container instead of round-tripping through grpcfuse) from a single anonymous volume to one **named, lockfile-keyed** volume per npm workspace member — the repo root plus every literal entry in `package.json`'s `workspaces` array (glob patterns aren't expanded in this first cut). Volumes are named `forge-deps-<lockfileHash>-<member>`, where `lockfileHash` hashes the repo-root `package-lock.json`: an unchanged lockfile lets a later dispatch against the same commit (e.g. the Shipping Reviewer verifying what an engineer just built, FG-372) reuse an already-installed volume instead of paying for a fresh install, and an edited lockfile invalidates the cache automatically by changing the volume name.

The container entrypoint (`docker/agent-entrypoint.sh`) runs `npm ci` (lockfile present) or `npm install` (no lockfile) from the repo root before exec'ing the agent command, so workspace links and `@forge/*` aliases resolve the same way they do on the host. Only the dispatch that first populates an empty cache key installs; a concurrent dispatch for the same key blocks on a host-side lock under `~/.forge/dependency-cache/` until the first dispatch either marks the key ready or releases the lock on a failed install. Read-only dispatches (reviewers and reds, including the Shipping Reviewer) never install — they mount the volumes read-only once the cache key is already marked ready, or proceed with no dependency mount at all rather than block or install.

A failed install exits the container with a dedicated sentinel exit code (123) before the agent command ever runs. Forge classifies that as `failure_kind: "verification_environment_unavailable"` — a new terminal kind alongside `container_crash`/`model_error` (see [Container crash vs. agent failure](#container-crash-vs-agent-failure)) — so a broken or stale dependency graph is reported as an environment failure, not misread as a test failure or a generic crash.

Cleanup is deliberately **not** wired to individual worktree disposal: a cache-key volume is shared by every task that sees the same lockfile hash, so tearing it down when one task's worktree is removed would break other tasks still referencing it. `forge-deps-*` docker volumes therefore accumulate on disk across runs; there is no `forge` command yet to prune them, so reclaiming the space today means removing them by hand (`docker volume ls | grep forge-deps-`, then `docker volume rm`).

Non-worktree (legacy) dispatch, and worktree dispatch on non-macOS hosts, are unaffected: they continue to mount the original single anonymous `node_modules` shadow volume, with no named cache, no lockfile hashing, and no automatic install.

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
| `clean_git` | Working tree is clean, ignoring host-local operational noise (`git status --porcelain` empty after filtering out `backlog/notes.md` and `.forge-scratch/`) |
| `pushed` | The closed commit is reachable from a remote branch |
| `container_verification` | Sum of `tests_run` across the campaign item's run tasks (INFORMATIONAL — excluded from outcome aggregation) |
| `host_verification` | Host typecheck + full suite passed and recorded |
| `deferral_linked` | If the ticket body declares deferred scope, a follow-up ticket is linked |

**Aggregation semantics.** `container_verification` is informational — present in `checks` but excluded from outcome aggregation. All other checks are required.

- `pass` — every required check is `pass`
- `fail` — at least one required check is a definite `fail`
- `unknown` — no required check is `fail`, but at least one required check is `unknown`

Missing evidence is always `unknown`, never `pass`. The `pushed` check follows this same principle when no remote is configured: `git remote` is checked first; if no remote exists, `pushed` resolves to `unknown` (not `fail`) — the commit's push status is unknowable without a remote. `container_verification` is populated from the campaign item's run task results — it sums `tests_run` across those tasks: `pass` when the sum is greater than zero, `fail` when the sum is exactly zero (zero container tests recorded), and `unknown` when the item has no run or no task recorded a numeric `tests_run`. It is informational and does **not** satisfy `host_verification`. `host_verification` resolves from the host-verification store using an **any-fail-wins** aggregation: `pass` only when one or more covering rows exist and *none* of them failed; `fail` when *any* covering row failed, even if a later covering row passed (a trailing pass does not override an earlier failure); `unknown` when no covering row exists. This is stricter than `forge campaign reconcile`'s **passing-row** model, where any covering pass ships the item regardless of earlier failures — aligning the two aggregation policies is tracked by FG-453. Matching requires exact `ticketId`, `projectDir`, and `gateName`, plus commit **coverage** rather than exact equality — `closedCommit` must be a git ancestor of a row's tested commit, and that tested commit must itself be reachable on the configured base branch (the gate always runs at `projectDir`'s current HEAD, never a checkout of `closedCommit`, so exact-sha matching would never find a real capture); evidence for a different gate, project, or ticket, or a commit that fails either half of the coverage check, is treated as absent. See [Recording host-verification evidence](#recording-host-verification-evidence) below.

**`requestedAction`** is `null` only when `outcome: pass`. Otherwise it names the concrete operator step(s) for each non-pass required check, joined with `"; "` — for example: `"run host typecheck + full suite, record the result, then re-audit"`, `"commit or revert the working tree"`, `"push <commit>"` (or `"no remote configured; push/PR unavailable"` when the `pushed` check is `unknown` due to no remote being configured), `"file a follow-up ticket and link it"`.

Example: `forge campaign report camp-abc123 --json` — the `doneAuditState` field on each item contains the result of running all eight checks against that item's ticket and git state.

### Recording host-verification evidence

`forge record-host-verification --ticket <id> --project-dir <path> --commit <sha> --command <cmd> --exit-code <n>` records a real host-command result in the host-verification store (`~/.forge/forge.db`). The collector reads this store when assembling done-audit input for `forge campaign report`.

Required flags:

| Flag | Description |
|---|---|
| `--ticket <ticketId>` | Ticket ID (e.g. `FG-419`) |
| `--project-dir <path>` | Absolute path to the project directory |
| `--commit <sha>` | Commit SHA that was verified — typically the tested HEAD; it satisfies a ticket's `closedCommit` when `closedCommit` is an ancestor of it and it is reachable on the base branch (exact match not required) |
| `--command <cmd>` | The exact command that was run |
| `--exit-code <n>` | Exit code of the command (`0` = pass, non-zero = fail) |

Optional: `--gate <name>` overrides the `gate_name` recorded for this evidence row; when omitted, `gate_name` defaults to the `--command` value. `--run-id <id>` associates the record with a forge run.

**Gate labeling and `host_verification`.** Two distinct defaults — do not conflate them. The **CLI `--gate` default** is the `--command` string. The **collector's required host gate default** is `"npm run test:all"` (per-project override via `.forge/config.json` `requiredHostGate`); `host_verification` passes only when a recorded `gate_name` matches this required gate. Consequence: `--command "npm run test:all"` without `--gate` records `gate_name = "npm run test:all"` and satisfies `host_verification`. A weaker command (e.g. `--command "npm run typecheck"`) without `--gate` records `gate_name = "npm run typecheck"` — supporting evidence only, which does not satisfy `host_verification`. An explicit `--gate "npm run test:all"` is the auditable operator choice to label an evidence row as the required gate; this closes a spoofing hole where a weak command could previously be auto-labeled as the required gate.

**Trust model.** Evidence is an audit trail in a trusted-operator context, not tamper-proof: `--command` and `--exit-code` record what was run and what it returned rather than an unverifiable bare assertion. The threat boundary is the operator — they control the host and could supply any exit code, but the recorder requires an explicit real-command invocation.

**Matching semantics.** Every consumer of this store (`forge campaign reconcile`'s shape-1 and shape-2 lanes, and `forge campaign report`'s done-audit `host_verification` check) applies the same rule: `ticketId`, `projectDir`, and `gateName` must match exactly, and the commit dimension is **coverage**, not exact equality — the ticket's `closedCommit` must be a git ancestor of a row's recorded commit, and that recorded commit must itself be reachable on the configured base branch. This lets a row recorded against a later base-branch commit still satisfy an earlier `closedCommit`, since the gate always runs at `projectDir`'s current HEAD, never a checkout of `closedCommit` itself. Evidence for a different gate, project, or ticket, or a commit that fails either half of the coverage check, does not satisfy `host_verification` — stale or non-covering evidence resolves to `unknown`, never `pass`.

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

### Execution lanes

Each campaign item carries an **execution lane** (FG-442) — the dispatch strategy the executor uses for that item. There are eight lanes:

| Lane | Dispatch mechanism |
|---|---|
| `full_feature` | the full `feature` workflow (architect → tech-lead → engineer → Shipping Reviewer → done-audit) — the pre-FG-442 default path, unchanged |
| `quick_implementation` | one run driving an `engineer` invoke followed by a `test-engineer` invoke |
| `docs_only` | a single invoke to the item's stored `agentRole` |
| `test_only` | a single invoke to the item's stored `agentRole` |
| `review_only` | a single invoke to the item's stored `agentRole` |
| `research_only` | a single invoke to the item's stored `agentRole` |
| `ticketing_only` | no agent dispatch — the item is recorded `outcome: skipped` with a `requestedHumanAction` naming the required backlog action |
| `manual` | no agent dispatch — the item is recorded `outcome: skipped` with a `requestedHumanAction` naming the required manual action |

**Classification happens once, at plan-authoring time — never inside `resolvePlan` or the executor.** `forge campaign plan --routes '<json>'` takes a JSON map of `ticketId -> compiled routing-policy route key` (e.g. `{"FG-10": "implementation_quick"}`) and runs the lane classifier against the compiled routing policy, folding a proposed `lane`, `laneRationale`, and `materialLaneAssumptions` into each item's plan entry (visible in both human and `--json` plan output). The judgment of which route a ticket falls under is supplied by the caller — an operator or orchestrator who has read the ticket — never inferred by Forge code keyword-matching ticket content. When `--routes` is supplied, tickets it omits, or tickets classified against a route key the compiled policy doesn't recognize (or whose compiled path is `manual`), fall to lane `manual`; if the routing policy isn't compiled at all, every ticket falls to `manual`.

**There is no silent default lane, and no automatic classifier.** `forge campaign plan` refuses — naming the unjudged ticket ids — when one or more resolved items have no lane judgment at all (i.e. `--routes` was omitted entirely, or covered only some items and no default was given). Lane judgment comes only from an operator/orchestrator-supplied `--routes` map or an explicit opt-in: `--default-lane <lane> --default-lane-rationale <text>`. `--default-lane` accepts only the blanket-safe lanes — `full_feature`, `quick_implementation`, `ticketing_only`, `manual` — because those never require picking a specific `agentRole`; the agentRole lanes (`docs_only`, `test_only`, `review_only`, `research_only`) must be routed individually via `--routes`, never defaulted blanket-wide. `--default-lane-rationale` is required whenever `--default-lane` is used. The default lane and its rationale are folded into every unjudged item's plan entry exactly like a `--routes` judgment, so they are part of `plan_hash` too — a defaulted lane is recorded, never silent. (`resolvePlan`'s own internal `full_feature` fold for an item with no lane at all still exists for legacy/programmatic callers, but the `campaign plan` CLI path never reaches it silently — it always refuses first.)

**The operator confirms or overrides the lane at the existing `forge campaign approve` gate — there is no separate lane-approval step.** Before recording the approval, `approve` prints `Lane basis being recorded:` followed by one `<ticketId>: lane=<lane> — <laneRationale>` line per item (JSON output carries the same data as a `laneBasis` array), so the operator sees exactly which dispatch strategy they are signing off on.

**The executor dispatches strictly by the frozen approved lane and never re-derives one at execution time.** `resolvePlan` stays pure: it only validates and folds an already-decided lane per item; the classification judgment lives entirely in the `campaign plan --routes` CLI path.

**`plan_hash` covers `lane`, `laneRationale`, and `materialLaneAssumptions`.** These fields live inside `canonicalContent.orderedItems`, so changing any of them for any item changes `plan_hash` — the same staleness mechanism that already guards ticket-list changes (`stale_plan`) also guards lane changes. Any lane change after approval requires a fresh `forge campaign approve` before `start`/`resume` will accept it.

See [Lane escalation](#lane-escalation) below for what happens when an item outgrows its assigned lane mid-campaign.

### Approval

`forge campaign approve <campaign-id> --rationale <text> [--by <operator>] [--json]` records a durable approval on a planned campaign. The command stamps `approved_by`, `approved_at`, `approval_rationale`, and snapshots the current `plan_hash` as `approved_plan_hash` in the database.

Preconditions checked at approval time:

- The campaign must be in `planned` or `paused` state; calling `approve` on any other status is an error.
- If the campaign is `paused` with any item still blocked on an unresolved `lane_escalation`, `approve` refuses unconditionally — regardless of whether `plan_hash` has moved since the pause. Run `forge campaign escalate-lane` first (see [Lane escalation](#lane-escalation)).
- A `paused` campaign is otherwise accepted **only when it carries a genuine fresh plan awaiting approval**: `plan_hash` must differ from the already-recorded `approved_plan_hash` — the shape produced by an `escalate-lane` step (see [Lane escalation](#lane-escalation)). A paused campaign whose `plan_hash` still equals its `approved_plan_hash` — e.g. one paused for an unrelated reason, such as a preserved `awaiting_gate` evidence campaign — is refused: there is nothing new to (re-)approve, and `approve` will not rewrite its approval metadata just because the campaign happens to be paused. Resolve that campaign via `forge campaign reconcile` or `resume` instead. This is enforced in both the CLI and the store (`approveCampaign`) as defense-in-depth.
- The campaign's stored `projectDir` must exist on disk and contain a `backlog` directory. A campaign with a missing or invalid project directory cannot be approved.

If the backlog has changed since the campaign was planned (re-resolving `sourceInput` now produces a different hash), `approve` emits a non-fatal warning but records the approval anyway. To establish a clean baseline after a backlog change, re-plan (`forge campaign plan`) and re-approve.

Before recording the approval, `approve` restates the lane basis for every item (see [Execution lanes](#execution-lanes)) — this happens whether the approval is a first approval or a re-approval after escalation.

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
| `recovery_needed` | One or more campaign items are in a non-resumable in-flight state (`running`, `awaiting_red`, or similar) — `awaiting_gate` and `blocked_by_red` are valid parked workflow states and do not trigger this — campaign stays `planned`, no dispatch occurs | Inspect the stuck item with `forge campaign show <id>` (the `Next action` line names the ticket and its `run_id`); reset the item to `pending` or mark it `failed` (manual DB operation — see crash recovery below), then start again |
| `already_running` | A `planned → running` CAS in the database rejected the transition — another `start` process already holds it | Wait or recover — see crash recovery below |

**Important:** `forge campaign plan` defaults to `--mode dry_run`. A `dry_run` campaign is plan-and-report only — `forge campaign start` will refuse it with `dry_run_not_executable`. To actually execute a campaign, plan with `--mode pilot` or `--mode sequential` and re-approve before starting.

If all preconditions pass, the campaign transitions to `running` via a compare-and-swap (CAS) and items execute **strictly one at a time**, each dispatched according to its approved [execution lane](#execution-lanes). A `full_feature` item runs through the configured **workflow** (default: `feature`), running the full run/gate machinery — architect, tech-lead, engineer, authoritative Shipping Reviewer, done-audit. The campaign drives each workflow run via `runNext`, auto-advancing `gate:auto` and `gate:verdict` steps when all authoritative reds passed. A failing or inconclusive verdict at a `gate:verdict` step parks the item as `blocked_by_red`; a `gate:human` step parks it as `awaiting_gate`. In both cases the campaign transitions to `paused` and the item's `requestedHumanAction` names the specific gate or step to resolve. `forge campaign resume` reattaches to the parked item and continues driving — no re-dispatch, no lost work.

The per-item **execution mode**, **workflow name**, and (since FG-442) **lane** are recorded in `canonicalContent.orderedItems` at plan time and are part of the `plan_hash`. Each lane has exactly one underlying dispatch mechanism: `full_feature` → `executionMode: 'workflow'` (default `workflowName: 'feature'`); `quick_implementation` → `executionMode: 'invoke_chain'` (engineer → test-engineer, one run); `docs_only`/`test_only`/`review_only`/`research_only` → `executionMode: 'invoke'` against the item's stored `agentRole`; `ticketing_only`/`manual` → `executionMode: 'none'` (no dispatch, ever). The pre-FG-442 single-agent invoke escape hatch — a per-item override supplying `executionMode: 'invoke'` directly, with no lane — still works byte-for-byte: it is folded to lane `review_only` and continues to render as `"invoke (escape hatch)"` in plan output and the report, alongside every other `docs_only`/`test_only`/`review_only`/`research_only` item (same underlying mechanism: a single invoke to a stored role). It is never the silent default. For each item the run's `run_id` is persisted **before** dispatch — this is the crash evidence trail.

**Outcome semantics (workflow path — default).** After the workflow run completes:

- `outcome: shipped` requires both a passing authoritative outcome AND a passing done-audit (`outcome: pass`). A completed workflow run alone is never treated as shipped.
- The authoritative outcome (FG-427) is resolved per reviewing task from the effective latest state, not a naive aggregate over every verdict the run ever recorded: within a task, a later authoritative `pass`, or a recorded qualifying force-advance (`decision: advance`, `force: true`, non-empty rationale) at the gate, supersedes an earlier authoritative `fail` on that same task — a historical fail that was legitimately fixed, re-reviewed, or force-advanced no longer wedges the item forever. A force-advance can only supersede an existing authoritative verdict on its task; it never substitutes for authoritative review on a task that has none. This is the same evaluator `forge campaign reconcile`'s shape-1 evidence uses (Fact 5, see [Reconcile](#reconcile)), so the drive path and reconcile cannot drift.
- A passing verdict with a failing or unknown done-audit maps to `outcome: blocked` (`blockerKind: campaign_system`).
- An unresolved authoritative fail (no later pass or qualifying force-advance superseding it on that task) maps to `outcome: blocked` (`blockerKind: scope`).
- No authoritative verdict recorded for any task maps to `outcome: blocked` (`blockerKind: campaign_system`).
- An abandoned or non-complete run maps to `outcome: blocked`.

**Outcome semantics (invoke escape-hatch path — `docs_only`/`test_only`/`review_only`/`research_only`, and the legacy manual `executionMode: 'invoke'` override).** When the item dispatches via a single invoke:

- If the task fails, or the agent's result reports a [lane escalation](#lane-escalation), the runner classifies the outcome and applies the blocker/continue policy — see [Blockers and continuation](#blockers-and-continuation) below.
- Otherwise — the invoke itself completed — the item ships only if that actually shipped the ticket: the backlog ticket must be `status: done` **and** carry a `closedCommit`. A completed agent task is never, by itself, treated as shipped.
- When both hold, the item is marked `lifecycleStatus: complete`, `outcome: shipped`.
- **When they don't** — the agent finished but the ticket isn't closed with a `closedCommit` — the item is **parked**, not completed: `lifecycleStatus: awaiting_gate`, no `blockerKind`, with `requestedHumanAction` naming the ticket and telling the operator to close it and run `forge campaign reconcile`, or resolve manually. The campaign transitions to `paused`. This is exactly the out-of-band shape `forge campaign reconcile`'s shape-2 evidence completes once the ticket is actually closed (see [Reconcile](#reconcile)) — an invoke-lane item can never reach `complete` on a finished-but-unshipped agent task. (Before this, an unshipped invoke-lane item was marked `complete` anyway and the campaign could finish `complete_with_issues` over work that never actually shipped — that gap is closed.)

**Outcome semantics (`quick_implementation` lane).** The engineer invoke and test-engineer invoke run as one run under a single `run_id`; if either invoke fails or reports a lane escalation, the same blocker/continue and escalation handling applies. Once both complete, the same shipped-gate applies as the invoke escape-hatch path above: the item is marked `outcome: shipped` only if the ticket reaches `status: done` with a `closedCommit`; otherwise it parks `awaiting_gate` (no `blockerKind`) with a `requestedHumanAction` to close the ticket and reconcile, or resolve manually, and the campaign pauses. Docs-impact is assessed advisory-only, and only when the item actually shipped, after both invokes complete (`quick_implementation` has no docs phase of its own, unlike `full_feature`'s pipeline, which always runs the documentation-maintainer); any warning is recorded in the item's `reason`.

**Only the `full_feature` lane runs the authoritative Shipping Reviewer and done-audit** (see workflow-path semantics above) — that is what lets it treat a passing verdict + passing done-audit as sufficient evidence of `shipped` on its own. The invoke-based lanes have no such authoritative review step, so they gate `shipped` purely on the backlog record (`status: done` + `closedCommit`) and park at `awaiting_gate` for `forge campaign reconcile` otherwise; they never infer shipped-ness from "the agent said it finished."

**Outcome semantics (`ticketing_only` / `manual` lanes).** These lanes never dispatch an agent — no run, no task, ever. The item is immediately marked `lifecycleStatus: complete`, `outcome: skipped`, with `requestedHumanAction` naming the required backlog or manual action.

**`--project` is verify-only.** If `--project <dir>` is provided, `start` checks that the resolved path equals the campaign's stored `projectDir` and refuses if they differ. It does **not** override the execution directory — the campaign always runs against the `projectDir` captured at plan time. Run `forge campaign start` from the same project root used for `forge campaign plan`, or pass `--project` pointing at that same root.

Example: `forge campaign start camp-abc123 --project ~/code/my-app` verifies the stored directory, then starts executing items sequentially.

### Blockers and continuation

**Readiness gate (pre-dispatch).** Before any workflow run or agent invocation is started for a pending item, the runner evaluates the ticket's readiness. If the outcome is `needs_refinement` or `blocked`, the item is held immediately — `lifecycleStatus: pending`, `outcome: held`, `blockerKind: readiness`, `continuePolicy: hold_dependents`. No run is created and no implementation tokens are spent. This is distinct from task-failure blockers below; the campaign transitions to `paused` when all items are processed and held items remain. When `forge campaign start` exits with `stopReason: paused`, the human output selects a message by item state in this branch order:

1. **Readiness-held** (one or more items have `outcome: held`, `blockerKind: readiness`): `campaign paused — N item(s) not ready: refine <ids> then resume`
2. **Dependency-held** (one or more items have `outcome: held` with no `blockerKind` — held because a `related` LOCAL item is still blocked; the branch filter is `blockerKind !== "readiness"`, which `undefined` satisfies; these items carry a `reason` string that the message displays, but `reason` is not part of the filter): `campaign paused — N item(s) held pending an unresolved blocker: <ids> (<reason> when a single item); resolve the blocker (see forge campaign show/report) then resume`
3. **Blocked** (one or more items have `outcome: blocked`): `campaign paused — N item(s) blocked; resolve and resume`
4. **Otherwise** (cooperative/operator-requested pause between items, no held or blocked items): `campaign paused between items — run resume to continue`

Reason string operators will see: `"held because not ready: <gaps>"`, e.g. `"held because not ready: Missing Problem section; Missing Acceptance Criteria section"`. The `requestedHumanAction` is: `"refine <ticketId> then resume — <refinementProposal>"`.

**Task-failure blockers.** When an item's workflow run or escape-hatch agent invocation fails, the runner classifies the failure as either SHARED (system-level) or LOCAL (agent-level) and applies a conservative hold/continue policy.

**SHARED blockers hold the whole campaign.** System-level failures indicate a condition that would affect every remaining item. The campaign transitions to `paused` (resumable) and all remaining items stay `pending`. Fix the shared issue, then run `forge campaign resume`.

SHARED blocker kinds: `auth`, `infrastructure`, `git_state`, `dependency`, `merge_conflict`, `campaign_system`, `lane_escalation`. This covers auth missing/expired/injection-failed, container crash/orphan/idle timeout, malformed or missing result, git state, dependency install, merge conflict, thrown dispatch errors (classified as `infrastructure`), and an item reporting that it outgrew its assigned lane — see [Lane escalation](#lane-escalation) below.

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

**Wedged on a stale historical fail.** `resume` never retries a `blockerKind: scope` item — a fresh failure requires new work, or the operator to confirm the existing work already ships. If durable evidence (closed ticket, reachable commit, host verification, a later authoritative pass or a recorded force-advance) shows the item is actually shipped, use `forge campaign reconcile <campaign-id>` (see [Reconcile](#reconcile)) rather than editing the database — it re-derives the outcome from those records and unholds anything downstream that was waiting on it.

**Delivered outside the feature pipeline.** An item can be parked at `awaiting_gate` with no `blockerKind` for either of two reasons: its ticket was legitimately re-routed to a non-pipeline lane (for example, a documentation-only change) and its `full_feature` run paused at a human gate on purpose rather than being driven through engineer+test-engineer; or (FG-442) it dispatched through an invoke-based lane (`quick_implementation`/`docs_only`/`test_only`/`review_only`/`research_only`) whose agent(s) finished but the ticket wasn't actually closed with a `closedCommit` — see [Outcome semantics](#start-sequential-execution) above. In both cases driving the item further through `resume` alone cannot terminate it, and hand-patching `lifecycleStatus` is not allowed. `forge campaign reconcile <campaign-id>` covers this shape (see [Reconcile](#reconcile)): once the ticket is closed, its `closedCommit` is reachable on the base branch, and the appropriate lane evidence exists, the item can be marked `complete` — so a campaign whose every item was genuinely delivered reaches `complete` instead of being stuck `paused` forever or mislabeled via `forge campaign abandon`.

### Lane escalation

An agent working a `docs_only`/`test_only`/`review_only`/`research_only`/`quick_implementation` item can report that the ticket needs more than its assigned lane provides, by returning a structured `laneEscalation: { reason, suggestedLane? }` field in its result. This is checked for that named field only — a generic model or tool error is never inferred as an escalation.

When a lane-escalation signal is detected:

- The item is recorded `lifecycleStatus: failed`, `outcome: blocked`, `blockerKind: lane_escalation`, with `requestedHumanAction` naming the item, its current lane, and (if supplied) the agent's suggested lane.
- Because `lane_escalation` is a SHARED blocker kind, the **whole campaign pauses** — not just the escalated item's dependents. An item that has outgrown its lane invalidates the approved plan basis entirely; scoping the hold to dependents-only would under-pause and let the rest of the campaign proceed against a plan the operator never actually approved.
- `forge campaign resume` **refuses** while any item is blocked on an unresolved `lane_escalation`, with stop reason `lane_escalation_unresolved` — a bare resume can never silently continue past an item that outgrew its lane.

**The only way to clear a lane escalation:**

1. `forge campaign escalate-lane <campaign-id> <ticket-id> --new-lane <lane> --rationale <text> [--agent-role <role>]` — mutates the escalated item's lane in the campaign's `sourceInput`, re-resolves the plan, and writes a fresh **unapproved** `plan_hash`. The command validates that `ticket-id` actually names a campaign item currently blocked on `lane_escalation` (an operator cannot escalate an unrelated or nonexistent ticket to mint a fresh hash and slip past the approval gate) and rejects a same-lane no-op — an escalation must actually change what dispatches. `--agent-role` is required when `--new-lane` is `docs_only`/`test_only`/`review_only`/`research_only`. The escalated item is reset to `pending` so it dispatches fresh, in its new lane, on the next resume.
2. `forge campaign approve <campaign-id> --rationale <text>` — approval is also the confirm/override point for a lane escalation, not a new command; the fresh plan hash from step 1 becomes `approved_plan_hash`. `approve` refuses unconditionally to rubber-stamp a `paused` campaign while any item is still blocked on an unresolved `lane_escalation` (see [Approval](#approval)) — this does not depend on whether `plan_hash` moved, so a fresh hash minted for the wrong ticket can never let approval through while the real escalated item stays unresolved.
3. `forge campaign resume <campaign-id>` — now proceeds normally.

Attempting `approve` or `resume` directly on a still-escalated campaign fails with an explicit error naming the required `escalate-lane` command.

### Crash recovery (MVP limitation)

`forge campaign start` holds its process for the campaign's entire duration, which may span several hours or overnight. **Crash recovery is not automated in this MVP.** If the `start` process dies mid-run (crash, SIGKILL, power loss):

- The campaign stays stuck in status `running`.
- A subsequent `forge campaign start` refuses with stop reason `not_planned`.
- Recovery evidence is durable: each item's `run_id` is persisted before dispatch. Run `forge campaign show <id>` to see which item was in flight when the process died.

**Note:** `forge campaign resume` only operates on a `paused` campaign. A campaign stuck in `running` after a process crash is not the same as paused — no automated recovery path exists yet; manual database intervention is still required.

**In-flight items are a hard block on both `start` and `resume`, with one important exception.** Items with `lifecycleStatus: awaiting_gate` or `blocked_by_red` are **valid parked workflow states** — they are resumable and do not trigger `recovery_needed`. `forge campaign resume` reattaches to these items and continues driving the workflow run from the parked position.

Items in any other non-terminal, non-pending state (`running`, `awaiting_red`, or similar) are genuinely stuck — `forge campaign start` and `forge campaign resume` both refuse with `recovery_needed` until those items are manually reset. If the campaign is reset to `planned` but the item is still stuck, `forge campaign start` refuses with `recovery_needed` and the item must be reset too before any work is dispatched. Use `forge campaign show <id>` to identify the stuck item: the `Next action` line names the ticket id, its current lifecycle status, and the `run_id` to inspect. Reset the item in the DB before retrying.

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

Before re-starting or resuming, inspect the run that was in flight (using the persisted `run_id`) to determine whether the workflow run completed before the crash. For the default workflow path, check whether the run reached `status: complete` with a passing verdict and done-audit before marking the item complete manually rather than re-dispatching the same work. For the invoke escape-hatch path, check whether the ticket reached `status: done` with a `closed_commit`.

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
- Every item also carries its [execution lane](#execution-lanes): a `lane: <lane> — <laneRationale>` line is printed beneath each item's summary row. If the item is blocked on `blockerKind: lane_escalation`, an additional line reads `LANE ESCALATION: item outgrew its approved lane — the whole campaign is paused pending re-approval of a new plan basis` (see [Lane escalation](#lane-escalation)). The JSON item rows carry `lane`, `laneRationale`, and `materialLaneAssumptions` fields for every item (`show`'s human text does not render `materialLaneAssumptions` directly; `report`'s does — see Report below).
- For a scope-blocked item (`blockerKind: scope`) refused specifically on a missing or failed host-verification gate, human text also prints a `host-verification-status: <text>` line rendering the `host_verification_not_recorded` / `host_verification_recorded_but_failed` distinction (see [Reconcile](#reconcile)) in operator-facing terms — "will be captured automatically" vs. a genuine failure. The same text is exposed as the `hostVerificationReconcileHint` field in JSON item rows (`null` when not applicable).
- A `Next action` line with the recommended operator step (`approve`, `start`, `resume`, `complete — none`, etc.). When a readiness-held item is the only hold, the line reads `refine <ticketId> then resume`; when a failed/blocked item needs resolution first, the line reads `resolve blocker <ticketId> (<blockerKind>) then resume`. When a campaign item is parked at a workflow gate or red block (`awaiting_gate` or `blocked_by_red`), Forge first checks whether that item was actually delivered outside the feature pipeline (see [Reconcile — out-of-band completion](#reconcile)); if the evidence-gated check is satisfied the line reads `<ticketId> delivered out-of-band — eligible for evidence-gated completion via forge campaign reconcile` instead of the generic gate text. Otherwise the line surfaces that item's `requestedHumanAction` — for example, `Human gate required at step verify in workflow feature` or `workflow blocked by failing verdict at step build`. When a campaign item is genuinely stuck in a non-resumable in-flight state and the campaign is `paused` (or `running` with a non-running in-flight item), the line instead reads: `recovery needed: item <ticket-id> is <lifecycle-status> (run <run-id>) — inspect the run; reset the item to pending or mark it failed before resuming`. When the source plan can no longer be resolved (e.g. a source ticket was deleted from the backlog since planning), the line reads: `plan can no longer be resolved (a source ticket may have been deleted) — re-plan with forge campaign plan`. Both `show` and `report` render the full persisted campaign and item state without error in this case; `start` and `resume` refuse non-zero with stop reason `plan_unresolvable`.

  Note: this out-of-band check only applies to the first parked item found; a paused campaign with multiple concurrently-parked items surfaces the distinction for that one item only (tracked as FG-444).

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
      "readiness": { "outcome": "ready", "gaps": [], "refinementProposal": null },
      "hostVerificationReconcileHint": null,
      "lane": "full_feature",
      "laneRationale": "no lane override supplied — defaulting to full_feature",
      "materialLaneAssumptions": []
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
- `safetyToContinue` — `can_start`, `can_resume`, `needs_resolution`, `dry_run_not_executable`, `running`, `needs_approval`, `stale`, `recovery_needed`, or `terminal`. `needs_resolution` means operator intervention is required before the campaign can resume — either a failed/blocked item (`lifecycleStatus: failed`, `outcome: blocked`) must be resolved, or an unrefined readiness-held item (`lifecycleStatus: pending`, `outcome: held`, `blockerKind: readiness`) must be refined; `can_resume` means neither condition is present. `dry_run_not_executable` means the campaign is in `dry_run` mode and cannot be started. `stale` covers two conditions: the plan hash changed since approval (`stale_plan`), or the plan can no longer be resolved at all because a source ticket was deleted from the backlog since planning (`plan_unresolvable`) — both require re-plan and re-approve. `recovery_needed` is returned when a campaign has an item in a genuinely stuck in-flight state (e.g. `running`, `awaiting_red`); items with `lifecycleStatus: awaiting_gate` or `blocked_by_red` are valid parked workflow states and do not trigger `recovery_needed` — the campaign can be resumed and the driver reattaches to the parked item. `forge campaign resume` refuses with `recovery_needed` only for genuinely stuck items that must be reset manually.
- `dirtyGitState` — `git status --porcelain` output from the campaign's `projectDir` with host-local operational noise lines (`backlog/notes.md`, `.forge-scratch/`) removed, or `null` if nothing remains after filtering
- `groupings` — items bucketed by outcome: `shipped`, `blocked`, `held`, `skipped`, `failed` (items with `outcome: needs_refinement` are counted in `failed`)
- `deferredScope` — always `[]` (reserved)
- `followUpTickets` — always `[]` (reserved)
- `nextOperatorAction` — narrative next step for the operator. On a `paused` campaign with a failed/blocked item, names the blocking ticket and its `blockerKind` (e.g. `resolve blocker FG-5 (git_state) then resume`); when blockers are resolved but a readiness-held item remains, prompts `refine <ticketId> then resume`; when blockers are resolved and only dependency-held items remain, prompts `resume — N held items will be reconsidered`. When a campaign item is parked at a workflow gate or red block (`awaiting_gate` or `blocked_by_red`), this checks the same out-of-band-completable evidence as `show`'s `nextAction` (see [Reconcile](#reconcile)) before falling back to `requestedHumanAction` — e.g. `FG-422 delivered out-of-band — eligible for evidence-gated completion via forge campaign reconcile`. On a `complete` campaign where shipped items have unresolved done-audit gaps, names the concrete operator steps (e.g. `shipped items have unresolved done-audit gaps — run host typecheck + full suite, record the result, then re-audit`).
- Per-item: all show item fields (including `readiness` and `hostVerificationReconcileHint` — see Show above), plus a `commit` field (the ticket's `closed_commit` for shipped items), `doneAuditState` (see below), `hostVerificationDetail` (the `detail` string from the `host_verification` check in `doneAuditState` when evidence was recorded, `null` otherwise — a different field from `hostVerificationReconcileHint`: `hostVerificationDetail` is done-audit's covering-row evidence detail, `hostVerificationReconcileHint` is reconcile shape-1's not-recorded/failed hint — both now resolve via the same ancestry-and-base-reachability coverage rule, so the two fields differ in which surface renders them, not in matching semantics), `branch` and `worktreePath` (populated when the campaign item ran in a Forge-managed worktree — see [Git discipline (v1)](#git-discipline-v1); `null` otherwise), null placeholders for `prUrl`, `verificationState`, `reviewerResult`, and the following workflow traceability fields: `executionMode` (the label for the lane's underlying dispatch mechanism — `"workflow"` for `full_feature`, `"invoke chain (engineer -> test-engineer)"` for `quick_implementation`, `"invoke (escape hatch)"` for `docs_only`/`test_only`/`review_only`/`research_only` and the legacy manual override, `"no dispatch"` for `ticketing_only`/`manual`), `workflowName` (the configured workflow name, e.g. `"feature"`; `null` except for `full_feature` items), `agentRole` (the agent role for invoke items; `null` otherwise), `taskSummaries` (array of `{phase, agentRole, status}` for each task in the item's run), and `verdictSummaries` (array of `{taskId, phase, verdict, authority, findingsCount}` for each verdict in the item's run). The human text rendering matches show (including the `lane:`/`LANE ESCALATION:` lines described above), plus a `lane-assumptions: <...>` line when `materialLaneAssumptions` is non-empty (report-only — `show`'s human text does not print this line): per item, `requestedHumanAction` is rendered as `action: <text>` when set, readiness outcome/gaps/refinementProposal are printed for items whose readiness is `needs_refinement` or `blocked` or that are readiness-held, a `host-verification-status:` line is printed when `hostVerificationReconcileHint` is set, the done-audit outcome is printed for each item (when outcome is not `pass`, gaps and `requestedAction` are also printed), `branch=` and `worktree=` are appended to the item line when set, and execution is printed per item (`execution: <label>`, with `[workflow=...]` or `[role=...]` where applicable) alongside task/verdict summaries.

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
4. No campaign item may be in a non-resumable in-flight state (`running`, `awaiting_red`, or similar). Items with `lifecycleStatus: awaiting_gate` or `blocked_by_red` are valid parked workflow states — `resume` reattaches to these items and continues driving the workflow run rather than refusing. For genuinely stuck items, `resume` refuses with `recovery_needed` and leaves the campaign `paused` — the item must be reset manually (see crash recovery above) before resuming.
5. No campaign item may be blocked on an unresolved `lane_escalation` (FG-442). `resume` refuses with `lane_escalation_unresolved` and leaves the campaign `paused` — see [Lane escalation](#lane-escalation) for the only clear path (`escalate-lane` → `approve` → `resume`).
6. `paused → running` transition succeeds via a CAS guard, preventing two concurrent `resume` calls from double-dispatching.

The driver then skips already-terminal items, reattaches to items parked at workflow gates (`awaiting_gate`) or red blocks (`blocked_by_red`) by re-entering the `driveWorkflowItem` loop, and re-evaluates held items by kind: readiness-held items (`blockerKind: readiness`) are re-evaluated against the **current** ticket body — released when the ticket is now `ready` or `exploratory`, kept held otherwise; dependency-held items are re-evaluated against the current blocked set — released when their blocker is resolved. Remaining `pending` items are dispatched in order.

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
| `recovery_needed` | One or more campaign items are in a non-resumable in-flight state (`running`, `awaiting_red`, etc.) — `awaiting_gate` and `blocked_by_red` are valid parked workflow states and do not trigger this — campaign stays `paused`, no dispatch occurs | Inspect the stuck item with `forge campaign show <id>` (the `Next action` line names the ticket, its lifecycle status, and `run_id`); reset the item to `pending` or mark it `failed` (manual DB operation — see crash recovery above), then resume |
| `lane_escalation_unresolved` | An item is blocked on `blockerKind: lane_escalation` (FG-442) — a bare resume can never silently continue past an item that outgrew its lane | Run `forge campaign escalate-lane <id> <ticket-id> --new-lane <lane> --rationale <text>`, then `forge campaign approve`, then resume — see [Lane escalation](#lane-escalation) |
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

### Reconcile

`forge campaign reconcile <campaign-id> [--by <operator>] [--json]` is an on-demand, non-destructive operator recovery command covering two distinct wedged-item shapes. Not the same as [Crash recovery](#crash-recovery-mvp-limitation), which repairs genuinely stuck in-flight items (`running`, `awaiting_red`) via manual SQL — reconcile is for items already parked in a terminal-ish shape that durable evidence shows are actually shipped. Reconcile takes no evidence argument of any kind in either shape; `--by` is attribution only and is never treated as evidence — every fact is re-read from durable Forge/git/backlog/host-verification records.

**Shape 1 — stale historical red-fail** (`blockerKind: scope`, `lifecycleStatus` of `failed` or `blocked_by_red`): for example, a `fail/authoritative` verdict that was later fixed, re-reviewed with a `pass/authoritative`, force-advanced with rationale, merged, host-verified, and closed, but the item still shows `outcome: blocked, blockerKind: scope`. Since FG-427 the drive path's own terminal-outcome reconciliation resolves the same effective-latest-state-per-task via the shared evaluator this shape's Fact 5 uses (below), so a run driven to completion no longer gets wedged this way in the first place. Shape 1 remains the recovery path for an item already wedged — from before that fix, or any other cause — since `resume` never retries a `blockerKind: scope` item on its own (see "Wedged on a stale historical fail" under [Start (sequential execution)](#start-sequential-execution), above).

**Shape 2 — delivered outside the feature pipeline** (`lifecycleStatus: awaiting_gate`, no `blockerKind`): either the item's ticket was re-routed to a non-pipeline lane (e.g. documentation-only work) and its feature run was intentionally parked at a human gate rather than driven through engineer+test-engineer, or (FG-442) it dispatched through an invoke-based lane whose agent(s) finished without the ticket actually being closed with a `closedCommit` (see [Outcome semantics](#start-sequential-execution) under Start, above). `executor.ts`'s `gate:human` path and its invoke-lane finalize sites are the only producers of `awaiting_gate`, and neither sets `blockerKind` — that absence is exactly what routes an item to this shape instead of shape 1.

Every other item is reported `not_applicable` and left untouched. The campaign itself must be `paused` — reconcile refuses immediately (`ok: false`, non-zero exit, zero items processed) if the campaign is in any other status.

**Shape 1 evidence.** An item is marked shipped only when ALL of the following hold; otherwise reconcile refuses that item and reports exactly which facts are missing:

| Missing-evidence code | Fact required |
|---|---|
| `ticket_status_not_done` | Ticket status (backlog record) is `done` |
| `ticket_closed_commit_missing` | Ticket has a `closedCommit` recorded |
| `closed_commit_not_reachable_on_base_branch` | `closedCommit` is reachable on the base branch (`git merge-base --is-ancestor`) |
| `host_verification_not_recorded` | No host-verification row covering `closedCommit` (see automatic capture below) exists yet for the required gate |
| `host_verification_recorded_but_failed` | At least one covering row exists, but none of them exited 0 |
| `no_authoritative_verdict_or_force_advance_event` | The item's run has at least one authoritative verdict or qualifying force-advance gate decision, on some reviewing task |
| `latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance` | Resolved per reviewing task (FG-427), not by a single run-wide highest-id: within each task that has an authoritative verdict, the highest-id event among {authoritative verdicts} ∪ {qualifying force-advances} is a `pass` or a qualifying force-advance (`decision: advance, force: true`, non-empty rationale) — an unresolved fail on any one task still blocks even when another task's latest state is a pass or force-advance |

`host_verification_not_recorded` and `host_verification_recorded_but_failed` are deliberately distinct codes (FG-440): the first means no real gate run has happened yet and one will be attempted automatically (see below); the second means the required gate already ran for real and failed — a genuine failure that must never be rendered as something to wait out. `forge campaign reconcile`'s human output and `forge campaign show`/`report` (`host-verification-status:` line, see [Show](#show) and [Report](#report)) render each code with this distinction; raw `--json` output always carries the unrewritten code.

**Automatic host-gate capture (FG-440).** Before evaluating shape-1 evidence for a scope-blocked item, reconcile checks whether a *covering* host-verification row already passed for the item's ticket at the configured `requiredHostGate`. A row covers the item when `closedCommit` is an ancestor of the row's tested commit **and** that tested commit is itself reachable on the base branch — not an exact-sha match, since the gate always runs at `projectDir`'s current HEAD, never a checkout of `closedCommit` itself. If no covering row has already passed, reconcile runs the required gate for real, in `projectDir`, at its current HEAD, and records the actual result before evaluating evidence:

- It refuses to run (and writes no row — the item resolves to `host_verification_not_recorded`) when the working tree is dirty or untracked, HEAD is not reachable on the base branch, the required gate has no matching `package.json` script, or the working tree/HEAD changed while the gate was running. An operator's uncommitted or off-branch state is never recorded as a tested result, and a skip is never a synthetic pass.
- Otherwise it records the actual exit code — `0` on a real pass, non-zero on a real failure, timeout, or crash, never fabricated — against the commit it actually tested (the run's real current HEAD, not `closedCommit`). `gate_name` and `command` are always the configured `requiredHostGate` string, never the argv that was executed, so a lesser command can never wear the required gate's label (the FG-419 gate_name spoofing vector).
- This is a passing-row model, not a once-ever model: a historical covering failure never permanently blocks the item — a later real covering pass ships it. A force-advance gate decision (fact 5 below) is a separate, independent fact and is never read as host-gate evidence, and vice versa.

Capture happens only as part of `forge campaign reconcile` itself — not automatically during `forge campaign drive`/`resume` — so an item merged through forge with no recorded host-verification ships on the next `reconcile` call, without a manual `forge record-host-verification` step.

**Shape 2 evidence.** Deliberately does not consult the item's own run events at all — the delivering work happened outside that run, so its run's event/verdict history (present, absent, or failing) cannot substitute for real out-of-band delivery evidence. An item is marked complete only when ALL of the following hold:

| Missing-evidence code | Fact required |
|---|---|
| `ticket_status_not_done` | Ticket status (backlog record) is `done` |
| `ticket_closed_commit_missing` | Ticket has a `closedCommit` recorded |
| `closed_commit_not_reachable_on_base_branch` | `closedCommit` is reachable on the base branch (`git merge-base --is-ancestor`) |
| `lane_evidence_missing` | Either the closing commit touches only non-code paths (a conservative allowlist of `.md`/`.mdx`/`.txt` files — any code file, any diff against more than one parent, or any git error safe-denies), or, when it touches code, a covering host-verification row exists for the required gate — `closedCommit` is an ancestor of the row's tested commit, that tested commit is itself reachable on the base branch, and at least one such covering row exited 0 (a passing-row model: a historical covering failure does not block once a later covering row passes) |

For both shapes, the `closedCommit` value and the configured base branch are validated against a strict sha/ref pattern before being passed to `git`, so a hand-edited ticket field can never be used to inject a git option. Both shapes use the same coverage rule (FG-452): a row recorded against a later commit still counts as long as `closedCommit` is an ancestor of that commit and the commit is itself reachable on the base branch (see automatic host-gate capture, above), since the gate always runs at `projectDir`'s current HEAD rather than a checkout of `closedCommit`. Before FG-452, shape 2 required exact-sha equality while shape 1 was already ancestry-based; the two lanes now share one rule.

**On success**, the item's `lifecycleStatus` moves to `complete`, `outcome` to `shipped`, and its blocker fields clear. Shape 1 records a `campaign_item.evidence_reconciled` audit event; shape 2 records a `campaign_item.out_of_band_reconciled` audit event — both carry the derived evidence, `--by` attribution if given, and a timestamp, and both supersede the stale/parked history without erasing it. Downstream items whose only blocker was the reconciled item are freed to dispatch on the next resume. Reconcile does not resume the campaign itself — it does not transition the campaign; run `forge campaign resume <campaign-id>` afterward to let the existing item-terminal transition move the campaign to `complete` once every item is terminal.

**Idempotent and race-safe.** Re-running reconcile against an already-shipped item reports it `not_applicable` and logs no additional audit event. The campaign-paused check and each item's write happen in one atomic transaction, so a concurrent `resume`/`start` that flips the campaign out of `paused` mid-reconcile stops further item mutation rather than racing it.

With `--json`:

```json
{
  "ok": true,
  "items": [
    { "ticketId": "FG-357", "status": "shipped" },
    { "ticketId": "FG-9", "status": "not_applicable" },
    { "ticketId": "FG-12", "status": "refused", "missing": ["host_verification_recorded_but_failed"] },
    { "ticketId": "FG-422", "status": "shipped" },
    { "ticketId": "FG-430", "status": "refused", "missing": ["lane_evidence_missing"] }
  ]
}
```

Example (shape 1): `forge campaign reconcile camp-922c83b7c577 --by steve` re-derives outcomes for every scope-blocked item, ships FG-357 once its closed commit, host verification, and superseding pass/force-advance all check out, then `forge campaign resume camp-922c83b7c577` continues the campaign past it.

Example (shape 2): a campaign item for a docs-only ticket re-routed to the documentation-maintainer lane sits at `awaiting_gate` after its architect gate. Once the ticket is closed with a `closedCommit` that only touches `.md` files and is reachable on `main`, `forge campaign reconcile <campaign-id>` ships it and a following `forge campaign resume <campaign-id>` reaches `complete` if it was the last outstanding item — `forge campaign show`/`report` also surface this eligibility ahead of time via the `Next action`/`Next operator action` line (see [Show](#show) and [Report](#report)), before reconcile is even run.

**Known limitation (FG-444).** The `Next action` / `Next operator action` line only evaluates out-of-band eligibility for the *first* parked item it finds; a paused campaign with multiple concurrently-parked items only surfaces the distinction for that one item on the human-readable surface. Reconcile itself is unaffected — it evaluates every item in the campaign independently regardless of how many are parked.
