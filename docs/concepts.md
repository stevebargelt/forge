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

Example: a run created via `cd ~/code/my-app && forge new feature "add login" --brief "..." --ticket FG-123` has `projectDir = /Users/you/code/my-app`. Every container spawned for that run mounts that path at `/project`.

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

A fanout parent never gets its own container (`dispatchFanoutStep` only spawns the children), so it can be left `running` forever if the process that would have finalized it dies mid-wave. Reconcile (FG-455 p2, extended FG-479) closes that gap: once every child is terminal, a parent still `running` with no `container.started` event is always failed with `failure_kind: "fanout_wave_orphaned"` — reconcile never completes it, even when every child completed, since all-children-complete only proves the wave finished, not that the parent's own host-side finalize (merge → integration gate → reds, `dispatchFanoutStep` in `runNext.ts`) ever ran; completing the parent from child aggregation alone would silently skip that whole sequence. The all-complete case gets a distinct `reason: "fanout_wave_unfinalized"` and message so an operator isn't told children failed or never finished when every one of them succeeded; otherwise it's the ordinary `reason: "fanout_wave_orphaned"` M/N-complete message. Either way, recovery is `forge recover <parent> --re-drive` (see [Orphaned task recovery](#orphaned-task-recovery)). A non-terminal child leaves the parent alone, since the wave may still be in flight.

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

Two failure modes, surfaced differently — but both emit `task.failed`; the machine-readable `failure_kind` in the event payload distinguishes them. **Container crash**: container exited non-zero with no result JSON (Docker issue, credential failure, or an OOM/kill that couldn't be positively confirmed as such) → `failure_kind: "container_crash"` — unless the runtime's stdout carries a provider/model error (invalid model, quota, 4xx), in which case it's attributed as `failure_kind: "model_error"` with the cause (#228). An OOM is `container_crash` only when it *isn't* positively identifiable as one: `failure_kind: "oom_killed"` is reached via either of two paths. Reconcile-time (FG-455 p4): reconcile finds a container gone and `docker inspect` confirms `OOMKilled` or exit code 137, so a later, separate process makes the call. Attached-exit (FG-455, invoke.ts/runNext.ts): the process still attached to the container reads its exit code directly — no `docker inspect` needed, the exit code is already in hand — and a bare exit 137 with no result classifies the same way via `classify()`; the operator-facing error reads `container killed (exit 137 — possibly OOM or an external kill)`. See [Orphaned task recovery](#orphaned-task-recovery). **Agent failure**: container exited 0 and wrote a result JSON with `status: "failed"` and an error reason → classified per context. Different follow-up actions. (There is no `task.crashed` event type — the failure taxonomy lives in the `task.failed` payload, not in separate event types.)

## Container causal evidence

`failure_kind` says *what class* of failure this was; it doesn't always say *why the container is gone*, and Forge previously let that gap get filled in by folklore — a missing container repeatedly got written up as "harness killed" or "session killed" when the only durable fact was that Docker had nothing left to inspect. FG-492 adds a `ContainerCausalEvidence` record (`containerName`, `startedAt`, `finishedAt`, `dockerExitCode`, `signal`, `oomKilled`, `dockerStateError`, and `containerExitedEventObserved`) captured on every task container's terminal path, so operator text can say what was actually confirmed and name what wasn't, instead of inferring a cause from symptoms.

`containerExitedEventObserved` is the central distinction: `true` means this Forge process was still attached when the container exited and ran `docker inspect` before it could be removed (docker-exec.ts's capture-at-close); `false` means reconcile found the container already gone with no prior `container.exited` event for this task, so any `docker inspect` fields present are a best-effort look at whatever the daemon still had lying around, not a confirmed exit. The record is stored under its own `containerEvidence` payload key (distinct from `OrphanEvidence`'s `evidence` key above, so the two never have to be disambiguated on the same event) and read back via `getContainerCausalEvidenceFromEvents`. `describeContainerEvidence` renders it as operator text; `missingContainerEvidence` names each specific gap (no `container.exited` event, docker exit code unavailable, `OOMKilled` unavailable, start/finish time unavailable) rather than implying more was confirmed than actually was.

This lets Forge distinguish four states without ever asserting an unproven cause:

- **Confirmed container exit** — `containerExitedEventObserved: true`, with whatever code/signal/`OOMKilled`/`State.Error` `docker inspect` returned.
- **Container disappeared without terminal evidence** — `containerExitedEventObserved: false`: no `container.exited` event was ever recorded for this task. This is the phrasing to use in journals and handoffs instead of "killed" when this is all the evidence shows.
- **Fanout parent derived failure** — a fanout parent never gets its own agent container (`dispatchFanoutStep` never gives it one; see [Fanout](#fanout)), so there is structurally no container evidence to gather. Its failure is derived entirely from its children's outcomes and must never be described as a killed agent.
- **Result missing after a clean exit** — `containerExitedEventObserved: true` with `dockerExitCode: 0`: the container is confirmed to have exited cleanly, it just never wrote a usable `result.json`. Distinct from a disappeared container — the exit itself isn't in question, only the result. (FG-492 review) `failure_kind: "result_missing"` also now joins `ORPHAN_EVIDENCE_KINDS` — see the attached-exit bullet under [Orphaned task recovery](#orphaned-task-recovery) — so `forge ops check`'s `orphaned_work_may_persist`-family detector fires off the real event this producer emits, not just a hand-built fixture.

`forge show <id>` prints a `container evidence:` line (plus any `missing:` gaps) for a failed task, and `forge show <id> --diagnostic` prints *only* that causal-evidence block — the four states above, whichever applies, plus the explicit missing-evidence list (`--diagnostic --json` for the same data as structured output). `forge status <run-id>` and `--json` render the same container-evidence line/field, the same orphan-recovery message, and the same fanout-wave-recovery message per failed task, using the same rendering helpers (`describeContainerEvidence`, `orphanRecoveryMessage`, `fanoutWaveRecoveryMessage`) as `forge show` — including the fanout-parent state above, which is distinguished from a bare, unexplained failure the same way in both commands. Two differences remain: `status`'s plain-text view only prints the `container evidence:` line when evidence was actually recorded, where `forge show`'s default view always prints one line, falling back to "no container evidence recorded" (both `--json` outputs always include the field, `null` when absent); and the `missing:` gap list / `missingContainerEvidence` is rendered by `forge show` (both its default view and `--diagnostic`) but never by `forge status`, in either plain text or `--json`. `forge ops check`'s `orphaned_work_may_persist`-family incidents (see [Orphaned task recovery](#orphaned-task-recovery) below) also name the same confirmed-vs-disappeared distinction — read off the `OrphanEvidence` tuple's own `containerExitedEventObserved`/exit-code/signal/`OOMKilled` fields rather than the `containerEvidence` record itself, since `ops/detect.ts` sits below `cli/` and deliberately doesn't import from `show.ts`.

**Retention for investigation.** The reap/retain decision is made by the caller (`invoke.ts` / `runNext.ts`, and `reconcile.ts` for a container it discovers already gone), keyed on `docker-exec.ts`'s `shouldRetainContainer` — but on the TASK's outcome, not the container's raw exit code. A container is reaped only once its task actually completes successfully (a valid result, task marked complete); every other outcome leaves it running-but-stopped instead of removed, so it stays inspectable for `forge show --diagnostic` / `docker inspect` after the fact. This matters because a clean (exit 0) container can still belong to a failed task — most notably `result_missing` (the agent exited cleanly but never wrote a usable `result.json`) and a pipeline step's `orphaned_needs_finalize` — and those are exactly the cases worth investigating; reaping on exit code alone would destroy the evidence at the moment it matters most. Set `FORGE_CONTAINER_RETENTION=off` to disable retention entirely (e.g. a disk-constrained host) — every task is reaped regardless of its outcome. Retention never blocks a retry: `forge retry` reaps the failed task's retained container before dispatching the new one (the new task gets its own `forge-<newTaskId>` container name, so there's no collision either way). A retained failed container may still hold injected secrets in its environment or filesystem, and there is no automatic time-bound reaper, so cleaning it up once an investigation is done is the operator's responsibility: `forge ops reap-containers` finds and removes them (`--dry-run` to preview, `--older-than-minutes <n>` to only reap containers past that age, `--project <dir>` / `--all` to scope, `--json` for structured output). The removal itself is best-effort: a docker error on an individual `rm` is reported as "not confirmed gone" and left for a later sweep, never treated as a crash; if `docker ps` itself can't be reached, that's reported as `dockerUnavailable` rather than silently scanning zero candidates.

FG-503 (redesign): candidacy is disk-truth-driven, not event-enumeration-driven. The scan runs `docker ps -a` scoped to `forge-*` — the actual containers docker knows about — and reconciles that list against task rows: a *stopped* `forge-<taskId>` container whose task is TERMINAL (`complete` or `failed`) and past the age threshold is a candidate, regardless of what events were or weren't recorded for it. A container still `running`, or one whose task is still non-terminal (`running`/`pending`/`awaiting_*`) even if the container itself looks stopped, is never touched. This replaced an earlier event-driven scan that required a `container.started` event for a failed task and additionally a `container.reap_failed` event for a completed one — which left a real gap: a task that completed successfully whose forge process then died between `markTaskComplete` and the reap call never got a `container.reap_failed` event (a happy-path reap deliberately records nothing on success), so its leaked container was permanently invisible to the sweep. Disk truth closes that gap — the container's mere existence is what makes it a candidate, not a durable trail of "reap attempted and failed." The `container.reap_failed` event (recorded on every reap-on-success site — a primary task, a red, a fanout child, and reconcile's own reap of a container it finds already gone) still exists as enrichment, not a candidacy requirement: a confirmed-gone sweep of such a leak lands in `completedTaskLeaks` (reported "now swept" in live mode, "would be swept" under `--dry-run` — FG-505 fixed the plain-text output claiming a completed action during a dry run), while a sweep attempt that errored lands in `completedTaskLeaksUnconfirmed` with "not confirmed gone" wording and is left for a later pass (FG-504). Either way a leaked container/shadow volume never goes unsweepable, including across the crash window the event-driven scan couldn't see; a confirmed-gone sweep also records a `container.reaped` resolution event that clears the corresponding `ops check` incident.

FG-505 closes the one remaining gap in that resolution write itself: the `container.reaped` insert (`logEvent`, a plain DB write) can throw — disk full, DB locked — after `docker rm` already succeeded, in which case the container is gone but the stale `container_reap_failed` incident has nothing left to reconcile it, since FG-503 candidacy only reconsiders containers `docker ps -a` still lists. The write is now non-fatal (try/catch; reported via `resolutionWriteErrors`, the sweep continues to the remaining candidates), and every live sweep also runs an **absence-heal** pass over the same `docker ps -a` listing it already fetched (zero extra docker calls): any unresolved `container.reap_failed` event (no later `container.reaped` for that `containerName`) whose container is entirely absent from that listing — gone for any reason, including a lost resolution write or an operator's manual `docker rm` — gets its `container.reaped` recorded with outcome `confirmed-absent-at-scan`, distinct from an actively-removed `killed`/`not_found`. Absence-heal only runs in live mode (dry-run writes nothing) and only when the container is truly absent (still-present containers are left to the ordinary candidate loop, or a later sweep). Surfaced in `--json` as `absenceHealed`, and in plain text as "healed by absence".

## Orphaned task recovery

Five `failure_kind`s cover recovery from a lost container or a lost fanout wave, and `forge recover <id>` is the operator-safe way to inspect and act on most of them: one lost-container kind with no evidence of persisted work, two lost-container kinds where work may have persisted, one for an orphaned fanout wave, and one for a pipeline step whose container finished but was never host-side finalized.

When the container is gone but left a usable result — a valid `result.json`, or one recovered from stdout — reconcile's response depends on the run's workflow (FG-479, refined FG-486). A task on a single-step **invoke** run or an **invoke_chain** run (campaign quick lanes chaining plain invokes on one run) has nothing left to do once the agent's result exists — both dispatch through `invoke.ts`, which has no host-side finalize sequence at all — so reconcile completes the task directly (`reason: container_gone_result_present` / `container_gone_result_recovered_from_stdout`). A **pipeline** step (any workflow other than `invoke` or `invoke_chain`, dispatched through `runNext.ts`) instead stays `running` through host-side finalize — worktree merge → integration gate → reds → gates — for as long as the container is attached; completing it from reconcile would silently skip every one of those trust gates. So a pipeline task in this situation is never completed by reconcile: it fails with `failure_kind: "orphaned_needs_finalize"` (`reason: container_gone_pipeline_unfinalized`) instead, and the agent's result is preserved (the task row and `result.json` on disk) as evidence for a human-directed re-drive. This is task-level only — run-level completion is narrower: reconcile may complete an idle **invoke** run outright (single step, unambiguous), but never an **invoke_chain** run this way, since whether the chain has another invoke coming is known only to the campaign executor. See below.

- **`orphaned`**: the container is gone (host/parent crash) and reconcile found no evidence of persisted work. Safe to `forge retry`.
- **`orphaned_work_may_persist`** (FG-455): the container is gone, no result was recoverable, but the worktree has changed files — real work may be sitting there. Reconcile refuses to discard it silently; `forge retry` on this kind is **not** retryable without `--force` (see `retry-policy.ts`), since a blind retry would re-dispatch over unreviewed work.
- **`oom_killed`**: a death positively identified as an OOM kill or exit code 137/SIGKILL — a more specific cause than the generic orphaned kinds. Reached via either of two paths:
  - **Reconcile-time** (FG-455 p4): the container is gone and `docker inspect` confirms `OOMKilled` or exit code 137. It takes precedence over `orphaned` / `orphaned_work_may_persist` whenever reconcile has this evidence, even over a dirty worktree — but a recoverable stdout result still outranks it: on an **invoke** or **invoke_chain** run the task completes instead of failing; on a **pipeline** step (any other workflow) it lands as `orphaned_needs_finalize` instead (FG-479, see below) — a recovered stdout result is still just the agent's output, not proof the step's host-side finalize ran. Reconcile records the full `OrphanEvidence` tuple (container name, exit code, changed files, etc.) on the `task.failed` payload, so `forge show`/`status`/`ops check` render the full recovery message for this path.
  - **Attached-exit** (FG-455): invoke.ts / runNext.ts read the exit code directly while still attached to the container — no `docker inspect` involved — and classify a bare exit 137 with a missing result as `oom_killed` the same way. Since FG-461, this path also records the `OrphanEvidence` tuple for every recovery-relevant attached-exit kind in `ORPHAN_EVIDENCE_KINDS` — `oom_killed`, `container_crash`, and `idle_timeout`, the abnormal-kill/crash kinds where a container may have left partial worktree work, and (FG-492 review) `result_missing` — a clean exit that produced no `result.json` still leaves a worktree diff worth surfacing — via `attachedExitEvidence()` (`reconcile.ts`), which reuses the same never-throwing git-status probe reconcile itself uses for changed files. It's skipped for a read-only dispatch (reds/audits can't persist work) and for `model_error` (a clean provider rejection); those stay report-only with no evidence. So `forge show`/`status` now render the same recovery line for an attached-exit `oom_killed` / `container_crash` / `idle_timeout` / `result_missing` failure that they already rendered for the reconcile-time path.

  Exit 137 alone, without a confirmed `OOMKilled` flag, may also be an external kill rather than an OOM; the operator-facing message reflects that uncertainty ("possibly OOM or an external kill"). Like `orphaned_work_may_persist`, `oom_killed` is **not** retryable without `--force` (see `retry-policy.ts`) and is continuable via `forge recover <id> --continue` when there's persisted work to adopt — except on a **pipeline** run, where FG-481 refuses `--continue` unconditionally regardless of persisted work (see below). `forge ops check` flags an `oom_killed` task whose recorded evidence shows a dirty worktree — a clean-worktree `oom_killed` has no persisted work at risk, so it raises no incident; an `oom_killed` event with no evidence at all (predating FG-455's evidence tracking) still raises, since an unknown worktree state is treated as possible risk rather than assumed clean. Since FG-461, `container_crash` / `idle_timeout` join this same check, but with the opposite default: they only raise an incident when evidence was actually recorded **and** shows changed files — a pre-FG-461 event or a read-only-dispatch crash carries no evidence payload at all, so it's skipped rather than flagged, avoiding a flood of retroactive incidents for the common crash case.
- **`orphaned_needs_finalize`** (FG-479): the container is gone but left a usable result — a valid `result.json` or one recovered from stdout — for a **pipeline** step (any workflow other than `invoke` or `invoke_chain`, FG-486). Reconcile refuses to complete it: doing so would silently skip the step's remaining host-side finalize (worktree merge → integration gate → reds → gates), which only ever runs while the task is still `running`. Instead the task is failed with reason `container_gone_pipeline_unfinalized`, and the result is preserved (task row + `result.json`) as evidence. **Not** retryable without `--force` (see `retry-policy.ts`) and **not** continuable via `forge recover --continue` — adopting the preserved result as complete would recreate the exact trust-gate bypass reconcile just refused to make. The prescribed path is to inspect the preserved result/worktree diff (`forge show <id>`), then `forge retry <id> --force` to re-run the step through the real finalize path. Single-step **invoke** runs and **invoke_chain** runs never see this kind — the old container-gone-with-result behavior (complete via `container_gone_result_present` / `container_gone_result_recovered_from_stdout`) is unchanged for them.
- **`fanout_wave_orphaned`** (FG-455 p2/p3, extended FG-479): a fanout parent (see [Fanout](#fanout)) whose process died mid-wave — reconciled to `failed` in both of two shapes, since reconcile never completes a fanout parent itself. If not every child completed, `reason: "fanout_wave_orphaned"` with the original M/N-complete message. If every child completed, `reason: "fanout_wave_unfinalized"` with a distinct message instead, because all-children-complete only proves the wave finished, not that the parent's own merge → integration-gate → reds sequence ever ran — completing the parent from child aggregation alone would skip that sequence, so it's failed either way. `forge retry` on the parent — and a direct `forge retry` on any of its children — is refused without `--force`; both point at `forge recover <parent> --re-drive` instead. `forge show` on this parent renders a `childSummary` (complete/total) recovery line in both human and `--json` output and recommends `forge recover <id> --re-drive`, not `forge retry`.

A related but distinct crash class, **not** covered by `forge recover` since no work container ever ran: a host crash during [dependency-cache provisioning](#agent-worktree-dependency-parity) (FG-437). The FG-376 short-provisioner is a separate, differently-named container (`forge-provision-<cacheKey>`) that runs *before* the task's own container, so a crash there previously stranded the task at `running` forever — the `container.started` gate that drives the five `failure_kind`s above never saw an agent container start, and the provisioner itself could leak. Provisioning now emits durable `container.provision_started` / `container.provision_succeeded` events carrying the real provisioner container name and cache key. Reconcile treats a `running` task with `provision_started` but neither `provision_succeeded` nor `container.started` as crashed mid-provision: if the provisioner container is still alive it defers (the FG-376 rule against killing a live install), and once the provisioner is confirmed gone it best-effort reaps any orphan (`docker rm -f`; a daemon error is never treated as confirmed cleanup) and fails the task with `failure_kind: "verification_environment_unavailable"`, pointing at `forge retry <id>` — dependencies may already be cached, so the retry can be fast. The cache key's `.lock`/`.ready` marker files are deliberately left alone here: a crash never writes the ready marker, and the stale lock is recovered by FG-376's own liveness-aware steal on the next provisioning attempt.

`forge recover <id>` takes a task or run id. Read-only by default: it recomputes a fresh evidence view (worktree vs. shared-project-dir source, changed files, a valid `result.json` or a stdout-inferred result) and prints a recommended next command; `--json` is the full structured surface.

- **`--continue`** adopts the orphaned task's persisted work and marks it complete, preferring a valid `result.json`, then a stdout-inferred result, then the raw diff as a last resort. It's fail-safe: it refuses with no writes when the task isn't in a recoverable orphaned state (`orphaned` / `orphaned_work_may_persist` / `oom_killed`) or when there's nothing to adopt. Its refusals split into two categories. **Force-overridable**: when the only evidence is the ambiguous shared project directory (no dedicated worktree), `--continue` refuses unless `--force` is passed, since the diff there may include unrelated uncommitted changes. **Not force-overridable, ever** (FG-481): when the task's run is a **pipeline** run (any workflow other than `invoke` or `invoke_chain`, FG-486), `--continue` refuses regardless of `failure_kind` and regardless of `--force` — `--force` here overrides only the shared-project-dir refusal above, never this one. `orphaned_needs_finalize` (FG-479) was already excluded from the recoverable set for exactly this reason, since it only ever arises on a pipeline step; FG-481 generalizes the refusal to every pipeline-run task in any continuable kind, because adopting persisted work as complete would recreate the same trust-gate bypass (worktree merge → integration gate → reds → gates never ran) whether the container died with `orphaned_needs_finalize` or with `orphaned` / `orphaned_work_may_persist` / `oom_killed`. The guidance is the same as `orphaned_needs_finalize`'s: `forge retry <id> --force` — a re-drive through the real finalize path, not an override of the `--continue` refusal. Single-step **invoke** runs and **invoke_chain** runs (FG-486) are unaffected and keep today's `--continue` behavior exactly — an `invoke_chain` task's container-gone recovery has no finalize to bypass, so adopting its persisted work is safe the same way an `invoke` task's is. Under the hood this uses `markTaskRecovered`, a compare-and-set that only ever fires from `status = 'failed'` — a distinct transition from the ordinary `markTaskComplete`, which deliberately blocks `failed → complete` to stop a completing container racing a `forge cancel`. An operator's explicit `--continue` is a different, gated decision.
- **`--re-drive`** re-dispatches an orphaned fanout wave in-run: it mints one fresh pending primary task in the step's phase (the same shape `dispatchFanoutStep`'s parent lookup already expects), leaving the old parent and children in place as an audit trail. It refuses if the parent is already `complete` or still `running`, or if a re-drive is already pending for that phase. By design this re-runs the **full** wave — there's no partial-index resume for just the children that failed.
- **`--force`** acknowledges an ambiguous shared-project-dir diff (or another refusal) and proceeds anyway.

`forge cancel` is fanout-aware and no longer abandons a run silently (FG-455 p2). Cancelling a fanout parent kills and fails every non-terminal child container too, not just the parent's. And when a cancel would leave a run with no dispatchable work, the run is abandoned only if `--abandon-run` is passed explicitly — without it, the task(s)/container(s) are still killed and marked failed, but the run stays `active` with guidance to either re-run with `--abandon-run` or recover/re-invoke to continue. This applies to both the single-task escalation path and cancelling a run id directly.

**Empty-result backfill (FG-455 p4, Mode A).** A separate recovery path from the `running`-task recovery above, since it acts on tasks already marked `complete`: a detached `forge invoke` whose wrapper process was killed can leave a task `complete` in the DB with an empty result — the structured output was never written back before the wrapper died. Reconcile now runs a second pass, scoped to `status = 'complete'` tasks with no result, that backfills it from the container's own `result.json` (the bind-mounted `/task/result.json`, which may have been written after the DB row was marked complete) or, failing that, FG-337 stdout synthesis. This pass never changes a task's status — it only fills in a missing result — and is idempotent: a task that already carries a result is left untouched, so re-running reconcile is always safe.

## Post-merge integration gate

Worktrees (FG-351/352/353) turn same-file textual races into detectable git conflicts, but they do not catch semantic cross-file breakage: agent A changes a signature in `foo.ts`, agent B (own worktree) still calls the old signature in `bar.ts` — the two branches touch no overlapping lines, so `git merge` succeeds cleanly with broken code merged and no signal. FG-357 closes that gap by building+testing the MERGED tree, not just merging it.

After a worktree branch merges cleanly — single-step merge-to-HEAD (FG-352) or fan-out integration-branch merge-to-HEAD (FG-353) — forge runs the project's own `npm run test:unit` script against the merged tree before the step is considered done. This runs on the host (the merge already landed on the host checkout; nothing container-specific is left to reproduce), reusing forge's own test entrypoint rather than a second test runner. If the project's `package.json` declares no `test:unit` script, the gate is a no-op (a project-config gap, not a merge defect, so it must not block every worktree merge).

A gate failure classifies into one of three `failure_kind`s, distinguished by the raw process-exit evidence off the gate's `execFileSync` call — status/signal/timedOut (FG-424):

- **`integration_failed`** — an ordinary non-zero exit (the test suite ran and failed on its merits), or any other case that isn't positively identified as a timeout or signal-kill. This is the fail-closed default: a non-signal, non-timeout infra failure (e.g. a corrupted on-disk cache) is indistinguishable from a real test failure here and intentionally still classifies as `integration_failed`, so broken code can never slip through unblocked as a false "infra" excuse. Non-retryable (retrying would re-dispatch against the same broken merge) — the recorded advice is to fix the break in code, or run `git reset --hard HEAD~1` in `run.projectDir` to undo the merge.
- **`integration_gate_timeout`** — the gate run hit its own timeout. Transient by nature, so it's retryable: a fresh attempt may complete.
- **`integration_gate_crashed`** — the gate run was killed by a signal outside the timeout path (e.g. `kill -9`, SIGSEGV). Non-retryable — the worktree's state after an abrupt kill isn't trustworthy to blindly re-run — with advice to inspect `run.projectDir` for a broken or half-updated toolchain/cache, resolve it, then retry.

Known false-negative bound: this heuristic only catches infra failures that surface as a timeout or a signal-kill. An infra failure that exits non-zero through a normal code path (for example, a stale cache that makes the test *runner itself* report failures) is not distinguishable from a real test failure and still classifies as `integration_failed`.

Unlike `integration_failed` (scoped to this item — see below), `integration_gate_timeout` and `integration_gate_crashed` classify as `blockerKind: "infrastructure"` (SHARED, pauses the whole campaign) since a gate timeout or signal-kill reflects host/environment state, not this item's own changes. On any of the three, the task returns before any cleanup, so the merged worktree/branch stay retained for inspection — the same no-discard contract as `merge_conflict`. The default 10-minute timeout is overridable via `FORGE_INTEGRATION_GATE_TIMEOUT_MS` (milliseconds).

## Agent worktree dependency parity

Only on macOS hosts, and only when a task dispatches into a git worktree (worktree mode — FG-345/351), forge upgrades the container-local `node_modules` shadow (`#245`, darwin-only, exists to keep every dependency write inside the container instead of round-tripping through grpcfuse) from a single anonymous volume to one **named, lockfile-keyed** volume per npm workspace member — the repo root plus every literal entry in `package.json`'s `workspaces` array (glob patterns aren't expanded in this first cut). Volumes are named `forge-deps-<lockfileHash>-<member>`, where `lockfileHash` hashes the repo-root `package-lock.json`: an unchanged lockfile lets a later dispatch against the same commit (e.g. the Shipping Reviewer verifying what an engineer just built, FG-372) reuse an already-installed volume instead of paying for a fresh install, and an edited lockfile invalidates the cache automatically by changing the volume name.

The container entrypoint (`docker/agent-entrypoint.sh`) runs `npm ci` (lockfile present) or `npm install` (no lockfile) from the repo root before exec'ing the agent command, so workspace links and `@forge/*` aliases resolve the same way they do on the host. Only the dispatch that first populates an empty cache key installs; a concurrent dispatch for the same key blocks on a host-side lock under `~/.forge/dependency-cache/` until the first dispatch either marks the key ready or releases the lock on a failed install. Read-only dispatches (reviewers and reds, including the Shipping Reviewer) never install — they mount the volumes read-only once the cache key is already marked ready, or proceed with no dependency mount at all rather than block or install.

A failed install exits the container with a dedicated sentinel exit code (123) before the agent command ever runs. Forge classifies that as `failure_kind: "verification_environment_unavailable"` — a new terminal kind alongside `container_crash`/`model_error` (see [Container crash vs. agent failure](#container-crash-vs-agent-failure)) — so a broken or stale dependency graph is reported as an environment failure, not misread as a test failure or a generic crash.

Provisioning itself runs in a separate, short-lived `forge-provision-<cacheKey>` container that starts before the task's own container, and it durably logs `container.provision_started` / `container.provision_succeeded` events (carrying that container's name and cache key) so a host crash mid-install is still visible to reconcile after the worktree is gone. See [Orphaned task recovery](#orphaned-task-recovery) for how reconcile detects and recovers that crash.

Cleanup is deliberately **not** wired to individual worktree disposal: a cache-key volume is shared by every task that sees the same lockfile hash, so tearing it down when one task's worktree is removed would break other tasks still referencing it. `forge-deps-*` docker volumes therefore accumulate on disk across runs; `forge dependency-cache prune` (FG-434) reclaims them — it removes every `forge-deps-*` volume plus its `~/.forge/dependency-cache/` `.ready`/`.lock` markers, skipping (not erroring on) any volume docker reports as still in use by a container, and only clearing a marker/lock for a cache key whose volume was actually removed. `--dry-run` reports candidates without removing anything; `--json` emits a structured `{volumesRemoved, volumesSkippedInUse, volumesError, markersRemoved, dryRun}` summary. A pruned volume simply re-provisions (a fresh install) the next time a task needs that lockfile hash.

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
| `host_verification` | Required gate passed and recorded — a real host run, or a green required CI check reused as evidence (FG-474) |
| `deferral_linked` | If the ticket body declares deferred scope, a follow-up ticket is linked |

**Aggregation semantics.** `container_verification` is informational — present in `checks` but excluded from outcome aggregation. All other checks are required.

- `pass` — every required check is `pass`
- `fail` — at least one required check is a definite `fail`
- `unknown` — no required check is `fail`, but at least one required check is `unknown`

Missing evidence is always `unknown`, never `pass`. The `pushed` check follows this same principle when no remote is configured: `git remote` is checked first; if no remote exists, `pushed` resolves to `unknown` (not `fail`) — the commit's push status is unknowable without a remote. `container_verification` is populated from the campaign item's run task results — it sums `tests_run` across those tasks: `pass` when the sum is greater than zero, `fail` when the sum is exactly zero (zero container tests recorded), and `unknown` when the item has no run or no task recorded a numeric `tests_run`. It is informational and does **not** satisfy `host_verification`. `host_verification` resolves from the host-verification store by applying the same **per-member passing-row** aggregation as `forge campaign reconcile` (FG-453, aligned with FG-440) to **every member of the derived gate list** — `deriveRequiredGateList(projectDir, requiredGate)`, shared with the reconcile collectors via `resolveGateCoverage`/`evaluateGateListCoverage` (`src/campaign/reconcile-collect.ts`); see [Evidence reuse for the deterministic gate](#evidence-reuse-for-the-deterministic-gate-fg-474) below for how the list is derived (single-gate/custom-gate projects derive a one-element list, so behavior there is unchanged). For each list member: `pass` when one or more covering rows exist for it and *at least one* of them has `exit_code 0`, even if earlier covering rows for that member failed — a covering pass ships that member regardless of earlier covering failures; `fail` when covering rows exist for it but *none* of them passed; `unknown` when no covering row exists for it. The overall check is `pass` when *every* list member resolves `pass`, **or** when the list's primary (first) member has a `source: 'ci'` passing row — `runAndRecordHostVerification` only ever writes `source: 'ci'` when every required CI job is green, so a ci-sourced primary pass is whole-workflow evidence covering the rest of the list on its own; `fail` when any member resolves `fail` and the ci shortcut doesn't apply — a real, provable gap on one member is never laundered into a pass by another member's success (FG-453); otherwise `unknown` when no member has a proven failure but at least one is still uncovered. Earlier covering failures are not discarded when a later covering row passes — they're retained as visible audit history: the check's `detail` line appends `earlier_covering_failures: N` (summed across list members) when the verdict is pass-with-prior-failures. Matching requires exact `ticketId`, `projectDir`, and `gateName` (each list member matched under its own gate name), plus commit **coverage** rather than exact equality — `closedCommit` must be a git ancestor of a row's tested commit, and that tested commit must itself be reachable on the configured base branch (the gate always runs at `projectDir`'s current HEAD, never a checkout of `closedCommit`, so exact-sha matching would never find a real capture); evidence for a different gate, project, or ticket, or a commit that fails either half of the coverage check, is treated as absent for that member. A covering row's `source` (`'host'`, the default, or `'ci'` — FG-474) does not change per-member aggregation: a CI-sourced passing row satisfies its member exactly like a host-run one (and, via the ci shortcut above, a ci-sourced primary-member pass satisfies the whole list on its own). See [Recording host-verification evidence](#recording-host-verification-evidence) below and [Evidence reuse for the deterministic gate](#evidence-reuse-for-the-deterministic-gate-fg-474) for how `'ci'` rows get written in the first place.

**Effective scope of a single row.** Coverage matching means one recorded row vouches for more than the single commit it names: within the same `ticketId` + `projectDir` + `gateName`, it satisfies *every* `closedCommit` that is an ancestor of the row's tested commit and reachable on the base branch — its effective trust scope is a commit **range**, not a single sha. This is intentional, not a gap: the gate always runs at `projectDir`'s current HEAD, never a checkout of `closedCommit`, so a row could never cover an exact-sha match in the first place. But it's a caveat an operator should keep in mind when recording evidence manually with `forge record-host-verification` — a row recorded against one ticket's commit can also silently satisfy an earlier `closedCommit` for the same ticket/project/gate, without a second `record-host-verification` call.

**`requestedAction`** is `null` only when `outcome: pass`. Otherwise it names the concrete operator step(s) for each non-pass required check, joined with `"; "` — for example: `"run host typecheck + full suite, record the result, then re-audit"`, `"commit or revert the working tree"`, `"push <commit>"` (or `"no remote configured; push/PR unavailable"` when the `pushed` check is `unknown` due to no remote being configured), `"file a follow-up ticket and link it"`.

Example: `forge campaign report camp-abc123 --json` — the `doneAuditState` field on each item contains the result of running all eight checks against that item's ticket and git state.

### Evidence reuse for the deterministic gate (FG-474)

`host_verifications` rows carry two more columns beyond ticket/project/commit/gate/command/exit-code: `source` (`'host'`, the default — a real host command execution; or `'ci'` — sourced from a green required CI check instead) and `ci_url` (the CI check's details URL, set only for `source: 'ci'` rows). This is a **separate, narrower** lookup from the ancestry-based `host_verification` coverage described above — that coverage question is "has *any* row, at *any* covered commit, satisfied this ticket's shipped evidence"; this one is "has the canonical deterministic gate already run, for real, against *this exact* commit" — asked by callers deciding whether to re-run the gate at all, before they'd otherwise execute it.

**"The gate" is a derived list, not always one command (FG-500).** `deriveRequiredGateList(projectDir, requiredGate)` (`src/store/host-verifications.ts`) is the single source of truth every consumer below shares for what counts as covering evidence: `[requiredGate]`, unless `requiredGate` is still the project default (`npm run test:all`) **and** the project's `package.json` defines a `test:extended` script — in which case the extended tier joins the list, `[requiredGate, "npm run test:extended"]`. A project with a custom `requiredHostGate`, or no `test:extended` script, still derives a one-element list, so single-gate/custom-gate projects behave exactly as before.

`findCoveringGateEvidence(ticketId, projectDir, sha, command)` (`src/store/host-verifications.ts`) answers, for an exact `(projectDir, sha, command)` pair, whether covering evidence already exists for **every member** of `deriveRequiredGateList(projectDir, command)` — not `command` alone. Command match per member is **exact** — every row is written with one canonical command string as both `gate_name` and `command`, so a row recorded under a narrower command (e.g. `npm run test` vs. the required `npm run test:all`) never satisfies its member. It checks, in order:

1. an existing **passing** `host_verifications` row, at the exact sha, for every list member — stops at the first uncovered member, so a fast-tier-only row can never stand in for a project's full tiered set;
2. else, only once this project's own CI is verified to actually run the required command **and** every job in its matched CI workflow is green at the exact sha: the required CI check (`CI / test`) is still the pairing that proves the command is backed by real CI content, but a green paired job alone is no longer sufficient — any completed failure on that sha, on any job in the matched workflow, disqualifies it outright (a same-sha pass/fail disagreement across re-runs is treated as a flake signal, never covering evidence), and a still-running or check-run-absent sibling job is likewise not covering, never a synthetic pass. This whole-workflow-green evidence covers every list member at once (it already proves every job passed), so no separate CI-sourced row is needed per extended-tier member.

Step 2's CI check is never trusted on its name alone. Because forge is host-global, `opts.projectDir` is an arbitrary managed project — a green `CI / test` there proves nothing about what that project's own workflow actually runs (the FG-419 gate_name-spoofing vector, narrowed but not closed by exact-command matching alone). `findCoveringGateEvidence` closes this by calling `projectCiRunsCommand(projectDir, checkContext, command)` (`src/store/host-verifications.ts`) **before** the check-runs provider is ever consulted: it reads `<projectDir>/.github/workflows/*.y{a,}ml` fresh, finds the workflow/job named by `checkContext` (`"CI / test"` → workflow `"CI"`, job `"test"`), and returns `true` only if one of that job's steps has a `run:` string that (trimmed) exactly equals `command`. A missing workflows dir, unparseable YAML, or no exactly-matching run step all fail closed — the check-runs provider is never called, so a same-named check on a project whose CI doesn't actually run the required command can never cover.

**Whole-workflow requirement (FG-495 review finding).** Pairing only proves that *one* job of the matched workflow runs the required command — it does not prove the whole gate passed if a sibling job is red, pending, or has no check run at all at that sha. Post-FG-495, forge's own CI workflow (and any project that adopts the same split) spreads the suite across sibling required jobs, e.g. `test` + `test-extended`; a green `CI / test` no longer means the gate is covered if `test-extended` is red or hasn't reported at that sha. `findCoveringGateEvidence` closes this with `projectCiWorkflowJobIds(projectDir, workflowName)` (`src/store/host-verifications.ts`), which shares the same workflow-YAML parsing as `projectCiRunsCommand` to enumerate every job id defined under the matched workflow. Before minting `source: 'ci'` evidence, every enumerated job id must show a green check run at the exact sha — a red, pending, or absent sibling job means no CI coverage. Enumeration itself fails closed: a missing workflows dir, no workflow matching `checkContext`'s workflow name, or a workflow with no jobs all make `projectCiWorkflowJobIds` return `null`, and `findCoveringGateEvidence` returns `null` in turn without the check-runs provider ever being consulted.

**Fails closed:** no evidence, a different sha, a different command, an uncovered member of the derived gate list, a project whose own CI content doesn't demonstrably run the required command, a job-enumeration failure, a red/pending/absent sibling job in the matched workflow, or a pending/failing/disagreeing check all return nothing, so the caller falls back to actually running the gate — never a synthetic pass.

Two consumers consult this before running the deterministic suite themselves:

- **`forge review-loop`'s verification phase** (`buildReviewLoopDeps.verify` in `src/cli/commands/review-loop.ts`) — only when the worktree is clean (a dirty tree never reuses, since a dirty diff under review wouldn't match what any recorded/CI evidence actually covers; a dirty tree runs `runVerification` locally right away). On a clean tree with no covering evidence yet, the loop does **not** immediately duplicate CI by running locally (FG-501): it probes the required CI gate's live status (`probeCiGateStatus`, `src/store/host-verifications.ts`) under the same fail-closed pairing/whole-workflow-green trust chain as evidence lookup. Pending checks are polled (default every 30s, up to a 20-minute timeout — `FORGE_CI_POLL_SECONDS`/`FORGE_CI_WAIT_TIMEOUT_SECONDS`), logging the sha, check contexts, state, elapsed time, and URL on every poll; once the checks go green it re-checks for covering evidence and reuses it (`ciOutcome: "reused_after_wait"`). A failing required check stops the loop directly as verification failed, citing the failing check's name and URL (`ciOutcome: "ci_failed"`) — no local run. Only a genuinely unavailable/unqueryable CI setup, or a wait that times out, falls back to a real local run (`ciOutcome: "local_fallback"`, with the operator-facing reason recorded). That fallback runs a fast-tier-only `typecheck` + `test` by default — `test:extended` is delegated to CI — restoring the full tier (equivalent to `scriptsForVerification()`, itself still gated by `deriveRequiredGateList` per FG-500) only when the operator passes `--local-extended`. Either way, the run note records what happened: reused evidence, the failing CI check, or which local tier ran and why.
- **`forge campaign reconcile`'s host-verification capture** (`runAndRecordHostVerification` in `src/campaign/reconcile-collect.ts`) — see [Automatic host-gate capture](#reconcile) below; since FG-500 its real-exec fallback runs and records every member of the derived gate list, not `requiredHostGate` alone.

A third consumer applies the same derived list but skips this exact-sha reuse check entirely: `forge campaign report`'s done-audit collector (`src/done-audit/collect.ts`) resolves the ancestry-based `host_verification` coverage described in [Done audit (mechanical)](#done-audit-mechanical) independently for **every** list member — a pass requires either a covering passing row for every member, or a single ci-sourced passing row on the list's primary (first) member, since whole-workflow CI evidence already proves every job and would otherwise double-charge CI once per list member.

### Recording host-verification evidence

`forge record-host-verification --ticket <id> --project-dir <path> --commit <sha> --command <cmd> --exit-code <n>` records a real host-command result in the host-verification store (`~/.forge/forge.db`). The collector reads this store when assembling done-audit input for `forge campaign report`. Because matching is ancestry-based, the row you record here covers more than just `--commit` — see [Effective scope of a single row](#done-audit-mechanical) above.

Required flags:

| Flag | Description |
|---|---|
| `--ticket <ticketId>` | Ticket ID (e.g. `FG-419`) |
| `--project-dir <path>` | Absolute path to the project directory |
| `--commit <sha>` | Commit SHA that was verified — typically the tested HEAD; it satisfies a ticket's `closedCommit` when `closedCommit` is an ancestor of it and it is reachable on the base branch (exact match not required) |
| `--command <cmd>` | The exact command that was run |
| `--exit-code <n>` | Exit code of the command (`0` = pass, non-zero = fail) |

Optional: `--gate <name>` overrides the `gate_name` recorded for this evidence row; when omitted, `gate_name` defaults to the `--command` value. `--run-id <id>` associates the record with a forge run.

**Gate labeling and `host_verification`.** Two distinct defaults — do not conflate them. The **CLI `--gate` default** is the `--command` string. The **collector's required host gate default** is `"npm run test:all"` (per-project override via `.forge/config.json` `requiredHostGate`); `host_verification` passes only when recorded `gate_name` rows cover every member of `deriveRequiredGateList(projectDir, requiredGate)` (`src/store/host-verifications.ts`) — see [Evidence reuse for the deterministic gate](#evidence-reuse-for-the-deterministic-gate-fg-474) above for how that list is derived. On a project with a custom `requiredHostGate`, or no `test:extended` script in `package.json`, the derived list has a single member and behavior is unchanged: `--command "npm run test:all"` without `--gate` records `gate_name = "npm run test:all"` and alone satisfies `host_verification`. On a **tiered** project — the default gate plus a `package.json` `test:extended` script — the derived list has two members, `["npm run test:all", "npm run test:extended"]` (FG-500); a single fast-tier row no longer satisfies `host_verification` by itself. The operator must also record a passing `--command "npm run test:extended"` row — or leave both to `forge campaign reconcile`'s real-exec capture, or to a whole-workflow-green CI check, which covers the full list at once (see [Evidence reuse for the deterministic gate](#evidence-reuse-for-the-deterministic-gate-fg-474)). Until every list member is covered, `host_verification` resolves to `unknown`, not `pass` (`src/done-audit/collect.ts`). A weaker command (e.g. `--command "npm run typecheck"`) without `--gate` records `gate_name = "npm run typecheck"` — supporting evidence only, which does not satisfy `host_verification`. An explicit `--gate "npm run test:all"` is the auditable operator choice to label an evidence row as the required gate; this closes a spoofing hole where a weak command could previously be auto-labeled as the required gate.

**Trust model.** Evidence is an audit trail in a trusted-operator context, not tamper-proof: `--command` and `--exit-code` record what was run and what it returned rather than an unverifiable bare assertion. The threat boundary is the operator — they control the host and could supply any exit code, but the recorder requires an explicit real-command invocation.

**Matching semantics.** Every consumer of this store (`forge campaign reconcile`'s shape-1 and shape-2 lanes, and `forge campaign report`'s done-audit `host_verification` check) applies the same rule: `ticketId`, `projectDir`, and `gateName` must match exactly, and the commit dimension is **coverage**, not exact equality — the ticket's `closedCommit` must be a git ancestor of a row's recorded commit, and that recorded commit must itself be reachable on the configured base branch. `projectDir` is canonicalized (`path.resolve`) on both insert and lookup (FG-431), so a row recorded with an equivalent-but-not-identical path string (relative vs. absolute, a trailing slash) is still found — this closes matching, it does not loosen it: `ticketId`, `gateName`, and `commitSha` still require exact equality. This lets a row recorded against a later base-branch commit still satisfy an earlier `closedCommit`, since the gate always runs at `projectDir`'s current HEAD, never a checkout of `closedCommit` itself. Evidence for a different gate, project, or ticket, or a commit that fails either half of the coverage check, does not satisfy `host_verification` — stale or non-covering evidence resolves to `unknown`, never `pass`.

Example: after `npm run test:all` exits 0 on commit `abc1234` for ticket `FG-419`:

```shell
forge record-host-verification \
  --ticket FG-419 \
  --project-dir /code/forge \
  --commit abc1234 \
  --command "npm run test:all" \
  --exit-code 0
```

On a tiered project (`test:extended` present in `package.json`, `requiredHostGate` still the default), this single call is not enough — repeat it with `--command "npm run test:extended"` at the same commit to cover the rest of the derived gate list, or skip manual recording for the extended tier and let `forge campaign reconcile` or a whole-workflow-green CI run capture it.

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

**`host_verification` in the packet.** The collector reads matching evidence from the host-verification store when the ticket has a `closedCommit`, applying the same per-member gate-list aggregation described in [Done audit (mechanical)](#done-audit-mechanical) above: a covering passing row for **every** member of the derived gate list, or a `source: 'ci'` passing row on the list's primary member (whole-workflow evidence that covers the rest of the list on its own) → `hostVerified: true`, even if an earlier covering row for a member failed; any member with covering rows but none passing, and no ci shortcut → `hostVerified: false`; no member proven to have failed but at least one still uncovered → `hostVerified: null` (unknown). The `host_verification` check's `detail` field carries one segment per contributing row — `gate`, `command`, `exit_code`, `commit`, `recorded_at`, and `source` (`'host'` or `'ci'` — FG-474), plus `ci_url` when `source` is `'ci'` and a URL was recorded — joined with `" | "` when a passing verdict cites more than one list member's row (single-gate/custom-gate projects still cite exactly one row, unchanged), plus `earlier_covering_failures` (summed across cited rows) when a prior covering failure is retained as audit history alongside a later covering pass. `doneAudit.outcome: "pass"` is reachable for real items once matching host-verification evidence has been recorded for the full derived gate list, either manually via `forge record-host-verification` (once per list member) or automatically — a real host run of every member, a reused row, or a whole-workflow-green CI row on the primary member from `forge campaign reconcile`'s capture step (see [Recording host-verification evidence](#recording-host-verification-evidence) and [Evidence reuse for the deterministic gate](#evidence-reuse-for-the-deterministic-gate-fg-474)).

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
| `recovery_needed` | Either (a) one or more campaign items are in a non-resumable in-flight state (`running`, `awaiting_red`, or similar) before dispatch even begins — `awaiting_gate` and `blocked_by_red` are valid parked workflow states and do not trigger this precondition check — campaign stays `planned`, no dispatch occurs; or (b) the drive loop's no-progress bound (FG-488) trips mid-run — see above — in which case the item ends this call parked `awaiting_gate` (no `blockerKind`) and the campaign is `paused` | For (a): inspect the stuck item with `forge campaign show <id>` (the `Next action` line names the ticket and its `run_id`) — once the campaign is `paused`, if the item turns out to be a transient (auth/infrastructure) failure, `forge campaign retry <campaign-id> <ticket-id>` (see [Retry](#retry)) resets it to `pending` for a clean re-dispatch; any other blocker needs re-plan or abandon. Then start again. For (b): inspect the run named in the item's `requestedHumanAction` (`forge show <runId>`), resolve the blockage, then `forge campaign resume` |
| `drive_error` | The drive path itself (`runNext`/`startRun`) threw instead of returning — FG-490. The executor catches it, durably records a `campaign_item.drive_error` event, parks the in-flight item, and transitions the campaign to `paused` before rethrowing the original error with resume guidance; the CLI renders it as this stop reason instead of a bare uncaught error (see drive-path catch-and-park below) | For a `runNext`-throw (item parked `awaiting_gate`, no `blockerKind`): inspect the run named in the rethrown error (`forge show <runId>`), resolve the issue, then `forge campaign resume <id>`. For a `startRun`-throw (item parked `failed`/`blocked`/`infrastructure`): `forge campaign retry <campaign-id> <ticket-id>` (see [Retry](#retry)) once the campaign is `paused`, then `forge campaign resume <id>` — the rethrown error names this exact sequence |
| `already_running` | A `planned → running` CAS in the database rejected the transition — another `start` process already holds it | Wait or recover — see crash recovery below |

**Important:** `forge campaign plan` defaults to `--mode dry_run`. A `dry_run` campaign is plan-and-report only — `forge campaign start` will refuse it with `dry_run_not_executable`. To actually execute a campaign, plan with `--mode pilot` or `--mode sequential` and re-approve before starting.

If all preconditions pass, the campaign transitions to `running` via a compare-and-swap (CAS) and items execute **strictly one at a time**, each dispatched according to its approved [execution lane](#execution-lanes). A `full_feature` item runs through the configured **workflow** (default: `feature`), running the full run/gate machinery — architect, tech-lead, engineer, authoritative Shipping Reviewer, done-audit. The campaign drives each workflow run via `runNext`, auto-advancing `gate:auto` and `gate:verdict` steps when all authoritative reds passed. A failing or inconclusive verdict at a `gate:verdict` step parks the item as `blocked_by_red`; a `gate:human` step parks it as `awaiting_gate`. In both cases the campaign transitions to `paused` and the item's `requestedHumanAction` names the specific gate or step to resolve. `forge campaign resume` reattaches to the parked item and continues driving — no re-dispatch, no lost work.

**No-progress bound (FG-488).** The drive loop inside `driveWorkflowItem` does not spin indefinitely waiting for a run to become dispatchable. It tracks a snapshot of the run's status and every task's status across passes; two consecutive passes that call `runNext` and dispatch nothing (no steps dispatched, completed, gated, or failed) while the run stays `active` with that snapshot unchanged trip a no-progress bound. This is the class-level backstop for the FG-475/FG-476 "active but nothing dispatchable" incident class, where the loop previously spun at 100% CPU until a manual process-tree kill. On trip, the item parks `lifecycleStatus: awaiting_gate` (no `blockerKind`) with `requestedHumanAction: "drive loop made no progress on run <runId>: it is active but nothing is dispatchable. Inspect the run's tasks (forge show <runId>), resolve the blockage, then resume."`, and the campaign transitions to `paused`. The `start`/`resume` call in progress when the bound trips exits with `stopReason: recovery_needed` rather than `paused` for that one call (see the stop-reason tables below) — but because the park lands in the ordinary `awaiting_gate`/no-`blockerKind` shape, it reads as a normal parked workflow state on every later check, not a stuck one: FG-485's liveness-first reattach re-examines the run's dispatchable work on the next `resume` and re-drives it directly once the underlying blockage is resolved, with no manual reset required.

**Drive-path catch-and-park (FG-490).** A thrown error from `runNext` or `startRun` inside the drive path no longer strands the campaign at `running` with no CLI path back. The executor catches it, records a durable `campaign_item.drive_error` audit event (`campaignId`, `itemId`, `ticketId`, the raw error message, and a timestamp) BEFORE any state change — the only audit trail of the raw error under a cron/service invocation where stderr may not be captured — then parks the in-flight item, transitions the campaign `running` → `paused`, and rethrows the ORIGINAL error wrapped with resume guidance. If the park write itself fails, that secondary failure is swallowed; the original drive error always propagates unmasked. The two throw shapes park differently on purpose: a `runNext` throw means a real, active run already exists behind the item, so it parks `lifecycleStatus: awaiting_gate` with no `blockerKind` — the same recoverable shape the no-progress bound above uses, so FG-485's liveness-first reattach re-drives it directly on the next `resume`. A `startRun` throw means no work was ever dispatched — there is no live run to reattach to — so it parks the item directly at its true terminal shape instead: `lifecycleStatus: failed`, `outcome: blocked`, `blockerKind: infrastructure`, alongside a terminal synthetic run row inserted for traceability; recovery is `forge campaign retry <campaign-id> <ticket-id>` (see [Retry](#retry)) once the campaign is `paused`, then `forge campaign resume`, and the rethrown error names exactly that sequence. `forge campaign start`/`resume` render this failure class as a structured result rather than a bare uncaught error: under `--json`, an object with `stopReason: "drive_error"`, `campaignId`, `ticketId`/`runId` (recovered by matching the parked item — undefined only if the park write itself failed), `error` (the original message), and `guidance` — which branches on the parked shape (FG-490 reopen): a `startRun`-throw (parked `failed`/`blocked`/`infrastructure`) gets `forge campaign retry <campaign-id> <ticket-id> && forge campaign resume <campaign-id>`, since bare resume silently skips a failed item; a `runNext`-throw (parked `awaiting_gate`) and the no-parked-item fallback both get the bare `forge campaign resume <campaign-id>`; human output is the wrapped message text, which names the same sequence. Either way the command exits non-zero.

The per-item **execution mode**, **workflow name**, and (since FG-442) **lane** are recorded in `canonicalContent.orderedItems` at plan time and are part of the `plan_hash`. Each lane has exactly one underlying dispatch mechanism: `full_feature` → `executionMode: 'workflow'` (default `workflowName: 'feature'`); `quick_implementation` → `executionMode: 'invoke_chain'` (engineer → test-engineer, one run); `docs_only`/`test_only`/`review_only`/`research_only` → `executionMode: 'invoke'` against the item's stored `agentRole`; `ticketing_only`/`manual` → `executionMode: 'none'` (no dispatch, ever). The pre-FG-442 single-agent invoke escape hatch — a per-item override supplying `executionMode: 'invoke'` directly, with no lane — still works byte-for-byte: it is folded to lane `review_only` and continues to render as `"invoke (escape hatch)"` in plan output and the report, alongside every other `docs_only`/`test_only`/`review_only`/`research_only` item (same underlying mechanism: a single invoke to a stored role). It is never the silent default. For each item the run's `run_id` is persisted **before** dispatch — this is the crash evidence trail.

**Outcome semantics (workflow path — default).** After the workflow run completes:

- `outcome: shipped` requires both a passing authoritative outcome AND a passing done-audit (`outcome: pass`). A completed workflow run alone is never treated as shipped.
- The authoritative outcome (FG-427) is resolved per reviewing task from the effective latest state, not a naive aggregate over every verdict the run ever recorded: within a task, a later authoritative `pass`, or a recorded qualifying force-advance (`decision: advance`, `force: true`, non-empty rationale) at the gate, supersedes an earlier authoritative `fail` on that same task — a historical fail that was legitimately fixed, re-reviewed, or force-advanced no longer wedges the item forever. A force-advance can only supersede an existing authoritative verdict on its task; it never substitutes for authoritative review on a task that has none. This is the same evaluator `forge campaign reconcile`'s shape-1 evidence uses (Fact 5, see [Reconcile](#reconcile)), so the drive path and reconcile cannot drift.
- A passing verdict with a failing or unknown done-audit maps to `outcome: blocked` (`blockerKind: campaign_system`).
- An unresolved authoritative fail (no later pass or qualifying force-advance superseding it on that task) maps to `outcome: blocked` (`blockerKind: scope`).
- No authoritative verdict recorded for any task (FG-475) maps to `outcome: blocked`; the blocker kind is derived from the run's most recent failed primary task via the same `classifyFailureKind` used above — e.g. a gate-rejected task with no `on_reject` recovery step (see `on_reject` in `how-to-new-workflow.md`) classifies as `blockerKind: scope`, a LOCAL blocker that holds only this item, not the whole campaign. Only a run with no failed primary task at all, or one whose failure kind doesn't classify to a specific LOCAL kind, falls back to the conservative `blockerKind: campaign_system` default. Before this, every such run defaulted to `campaign_system` unconditionally — a gate-rejected item with no `on_reject` also used to hang `forge campaign resume` outright (the run never reached a terminal status at all); both are fixed by the same run-settledness reachability check (`isRunSettled` in `ready-queue.ts`), consumed by `gate.ts`, `runNext.ts`, and this reconciliation step alike.
- An abandoned or non-complete run maps to `outcome: blocked`.

**Outcome semantics (invoke escape-hatch path — `docs_only`/`test_only`/`review_only`/`research_only`, and the legacy manual `executionMode: 'invoke'` override).** When the item dispatches via a single invoke:

- If the task fails, or the agent's result reports a [lane escalation](#lane-escalation), the runner classifies the outcome and applies the blocker/continue policy — see [Blockers and continuation](#blockers-and-continuation) below.
- Otherwise — the invoke itself completed — the item's shipped-ness is no longer derived from ticket frontmatter alone (FG-483). Drive-time finalize evaluates the SAME shared `composeOutOfBandEligibility` composition that `forge campaign resume`'s FG-441 reattach and `forge campaign reconcile`'s shape-2 evidence already use (recorded as `decidedBy: 'campaign_drive'` in the audit trail, to distinguish the call site) — `evaluateOutOfBandEvidence`/`collectOutOfBandEvidence` (ticket `done`, `closedCommit` reachable on the base branch, and lane evidence: the closing commit is docs-only, or a passing host-verification row already covers it) composed with the run's own authoritative-outcome fact (`authoritativeOutcomeContribution`/`collectReconcileEvidence`). A ticket at `status: done` with a non-empty `closedCommit` string is no longer sufficient by itself: the commit must actually be reachable on base, and a code-touching commit must already have a covering passing host-verification row.
- When the composition is `eligible`, the item is marked `lifecycleStatus: complete`, `outcome: shipped`, atomically (CAS-guarded against a concurrent pause/abandon landing between the evidence check and the write), and a `campaign_item.evidence_reconciled` audit event is recorded.
- **When it isn't** — eligibility evaluates false (for example the ticket isn't done yet, the `closedCommit` isn't reachable on base, or a code-touching commit has no covering passing host-verification row) — the item is **parked**, not completed: `lifecycleStatus: awaiting_gate`, no `blockerKind`, with `requestedHumanAction` naming the specific missing evidence and telling the operator to run `forge campaign reconcile`/`forge campaign resume`, or resolve manually. The campaign transitions to `paused`, and a `campaign_item.evidence_reconcile_refused` audit event is recorded. Drive-time finalize only **evaluates** existing evidence — it never runs a real host-verification gate itself (that capture step remains `forge campaign reconcile`-only), and this check introduces no auto-merge. Since the item was dispatched via invoke it retains a `runId`, so a subsequent `forge campaign resume` or `forge campaign reconcile` evaluates the identical composition and ships it the moment the missing evidence appears — see [Delivered outside the feature pipeline](#start-sequential-execution) below. (Before FG-483, `status: done` plus any non-empty `closedCommit` string — hand-editable ticket frontmatter, with no commit-reachability check and no host-verification row required — was sufficient to mark the item shipped; that frontmatter-trust gap is closed.)

**Outcome semantics (`quick_implementation` lane).** The engineer invoke and test-engineer invoke run as one run under a single `run_id`; if either invoke fails or reports a lane escalation, the same blocker/continue and escalation handling applies. Once both complete, the same evidence-gated finalize applies as the invoke escape-hatch path above (FG-483: the identical `composeOutOfBandEligibility` composition, never ticket frontmatter alone) — the item is marked `outcome: shipped` only when that composition evaluates `eligible`; otherwise it parks `awaiting_gate` (no `blockerKind`) with a `requestedHumanAction` naming the missing evidence, and the campaign pauses. Docs-impact is assessed advisory-only, and only when the item actually shipped, after both invokes complete (`quick_implementation` has no docs phase of its own, unlike `full_feature`'s pipeline, which always runs the documentation-maintainer); any warning is recorded in the item's `reason`.

**Only the `full_feature` lane runs the authoritative Shipping Reviewer and done-audit** (see workflow-path semantics above) — that is what lets it treat a passing verdict + passing done-audit as sufficient evidence of `shipped` on its own. The invoke-based lanes have no such authoritative review step, so instead of a done-audit they gate `shipped` on the same out-of-band evidence composition `forge campaign reconcile`/`resume` use — ticket `done`, `closedCommit` reachable on base, and lane evidence (the existing non-code out-of-band classification for docs-only lanes, or a covering passing host-verification row for code-touching commits) — and park at `awaiting_gate` for `forge campaign reconcile`/`resume` otherwise (FG-483); they never infer shipped-ness from ticket frontmatter alone, nor from "the agent said it finished."

**Outcome semantics (`ticketing_only` / `manual` lanes).** These lanes never dispatch an agent — no run, no task, ever. The item is immediately marked `lifecycleStatus: complete`, `outcome: skipped`, with `requestedHumanAction` naming the required backlog or manual action.

**`--project` is verify-only.** If `--project <dir>` is provided, `start` checks that the resolved path equals the campaign's stored `projectDir` and refuses if they differ. It does **not** override the execution directory — the campaign always runs against the `projectDir` captured at plan time. Run `forge campaign start` from the same project root used for `forge campaign plan`, or pass `--project` pointing at that same root.

Example: `forge campaign start camp-abc123 --project ~/code/my-app` verifies the stored directory, then starts executing items sequentially.

### Blockers and continuation

**Readiness gate (pre-dispatch).** Before any workflow run or agent invocation is started for a pending item, the runner evaluates the ticket's readiness. If the outcome is `needs_refinement` or `blocked`, the item is held immediately — `lifecycleStatus: pending`, `outcome: held`, `blockerKind: readiness`, `continuePolicy: hold_dependents`. No run is created and no implementation tokens are spent. This is distinct from task-failure blockers below; the campaign transitions to `paused` when all items are processed and held items remain. When `forge campaign start` exits with `stopReason: paused`, the human output selects a message by item state in this branch order:

1. **Readiness-held** (one or more items have `outcome: held`, `blockerKind: readiness`): `campaign paused — N item(s) not ready: refine <ids> then resume`
2. **Dependency-held** (one or more items have `outcome: held` with no `blockerKind` — held because a `related` LOCAL item is still blocked; the branch filter is `blockerKind !== "readiness"`, which `undefined` satisfies; these items carry a `reason` string that the message displays, but `reason` is not part of the filter): `campaign paused — N item(s) held pending an unresolved blocker: <ids> (<reason> when a single item); resolve the blocker (see forge campaign show/report) then resume`
3. **Blocked** (one or more items have `outcome: blocked`): items with a transient (`auth`/`infrastructure`) `blockerKind` are named separately from the rest: `campaign paused — N item(s) blocked on a transient failure (<ids>) — run \`forge campaign retry <campaign-id> <ticket-id>\` for each, then resume` (see [Retry](#retry)); any remaining items with another `blockerKind` are reported as `M item(s) blocked (<ids>) — inspect and re-plan or abandon`; when both kinds are present in the same pause, the two clauses are joined with `; `
4. **Otherwise** (cooperative/operator-requested pause between items, no held or blocked items): `campaign paused between items — run resume to continue`

Reason string operators will see: `"held because not ready: <gaps>"`, e.g. `"held because not ready: Missing Problem section; Missing Acceptance Criteria section"`. The `requestedHumanAction` is: `"refine <ticketId> then resume — <refinementProposal>"`.

**Task-failure blockers.** When an item's workflow run or escape-hatch agent invocation fails, the runner classifies the failure as either SHARED (system-level) or LOCAL (agent-level) and applies a conservative hold/continue policy.

**SHARED blockers hold the whole campaign.** System-level failures indicate a condition that would affect every remaining item. The campaign transitions to `paused` (resumable) and all remaining items stay `pending`. Fix the shared issue, then run `forge campaign resume`.

SHARED blocker kinds: `auth`, `infrastructure`, `git_state`, `dependency`, `merge_conflict`, `campaign_system`, `lane_escalation`. This covers auth missing/expired/injection-failed, container crash/orphan/idle timeout, malformed or missing result, git state, dependency install, merge conflict, thrown dispatch errors (classified as `infrastructure`), a post-merge integration gate run that timed out or was killed by signal (FG-424's `integration_gate_timeout`/`integration_gate_crashed`, also `infrastructure` — see [Post-merge integration gate](#post-merge-integration-gate)), and an item reporting that it outgrew its assigned lane — see [Lane escalation](#lane-escalation) below.

**LOCAL blockers apply the dependency policy.** When the agent ran but could not complete the ticket (scope, acceptance, or its own tests), the failure is LOCAL. The runner records the blocked item (`lifecycleStatus: failed`, `outcome: blocked`, `blockerKind`, `continuePolicy`, `reason`, `requestedHumanAction`) and then evaluates each remaining `pending` item against the blocked item using the ticket's `related` metadata only — no deeper inference:

`classifyFailureKind` maps `model_error`, `tool_error`, `red_blocked`, `gate_rejected`, and (FG-426) `integration_failed` to `blockerKind: scope` — all are outcomes where the agent ran and produced a concrete, operator-fixable result on this item alone, not a condition that would affect every remaining item. `integration_failed` (FG-357's post-merge integration gate — see [Post-merge integration gate](#post-merge-integration-gate)) means the merge itself was clean but build/test of the merged tree failed; that's scoped to this item's changes, so it gets the LOCAL/dependency policy above instead of the SHARED `campaign_system` default. The gate's other two outcomes, `integration_gate_timeout` and `integration_gate_crashed` (FG-424), reflect host/environment state rather than this item's changes, so they classify as the SHARED `infrastructure` kind instead — see [Post-merge integration gate](#post-merge-integration-gate).

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

**Wedged on the campaign_system SHARED default (FG-502).** A `blockerKind: campaign_system` item is not necessarily lost work — before FG-502 the only recourse was `forge campaign abandon`, even when the ticket had genuinely shipped. `forge campaign reconcile <campaign-id>` now also evaluates this shape (Reconcile's shape 3, see [Reconcile](#reconcile)), against the same out-of-band evidence bar shape 2 uses. If the evidence holds, the item ships with a distinct `campaign_item.campaign_system_reconciled` audit event and the campaign can proceed via `resume`; if it doesn't, reconcile refuses and names the missing facts, same as any other shape.

**Delivered outside the feature pipeline.** An item can be parked at `awaiting_gate` with no `blockerKind` for either of two reasons: its ticket was legitimately re-routed to a non-pipeline lane (for example, a documentation-only change) and its `full_feature` run paused at a human gate on purpose rather than being driven through engineer+test-engineer; or (FG-442, tightened by FG-483) it dispatched through an invoke-based lane (`quick_implementation`/`docs_only`/`test_only`/`review_only`/`research_only`) whose agent(s) finished but drive-time's evidence composition wasn't `eligible` — the ticket isn't closed with a `closedCommit` yet, or it is but the commit isn't reachable on base, or (for a code-touching commit) no covering passing host-verification row exists — see [Outcome semantics](#start-sequential-execution) above. Hand-patching `lifecycleStatus` is never allowed. As of FG-460, whether `resume` alone can terminate such an item depends on the closing commit's lane: if the ticket is now closed with a `closedCommit` that is docs-only (touches only `.md`/`.mdx`/`.txt` paths) and the run's own authoritative outcome, if any, is clean, `resume`'s FG-441 reattach reaches the same verdict reconcile's shape 2 would and ships the item directly on the next `resume` — no `forge campaign reconcile` call needed. If the closing commit touches code, `resume` never runs or captures a real host-verification gate (that capture step is reconcile-only), so `resume` alone refuses (`lane_evidence_missing`) until either a passing host-verification row already covers the commit (for example, recorded manually via `forge record-host-verification`) or `forge campaign reconcile <campaign-id>` runs the gate and captures it (see [Reconcile](#reconcile)). Either way the item ships through the same evidence-gated composition: once the ticket is closed, its `closedCommit` is reachable on the base branch, and the appropriate lane evidence exists, the item is marked `complete` — so a campaign whose every item was genuinely delivered reaches `complete` instead of being stuck `paused` forever or mislabeled via `forge campaign abandon`.

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

**Scope: this section covers genuine process death only.** If the `start`/`resume` process itself is gone (killed, powered off, host crashed) mid-run, nothing is left to catch the in-flight item, and the manual SQL below is still the only way out. This is a different failure class from a drive-path error thrown while the process is still alive: since FG-490, a `runNext`/`startRun` throw inside a live process is caught, durably recorded as a `campaign_item.drive_error` event, and parks the campaign to `paused` automatically — no manual database step required (see [drive-path catch-and-park](#start-sequential-execution) under Start).

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

This table covers campaign-*status* transitions only. `forge campaign retry` (see [Retry](#retry)) is an item-level operation — it resets a single transiently-failed item to `pending` without moving the campaign out of `paused`.

### Show

`forge campaign show <id> [--json]` prints the current state of a campaign. Read-only; does not mutate any state.

Human output includes:

- Campaign status, mode, `projectDir`, and approved plan hash
- Staleness indicator: whether the current plan hash matches the approved hash
- The active item, if any (ticket id and run id)
- Per-item rows: ticket id, title, lifecycle status, outcome, blocker kind, run id, reason, and `requestedHumanAction` (rendered as `action: <text>` when set). For items whose readiness outcome is `needs_refinement` or `blocked`, or that are readiness-held (`outcome: held`, `blockerKind: readiness`), the human text also prints the readiness outcome, gaps (`;`-delimited, omitted when empty), and refinement proposal on separate indented lines. (`continuePolicy` is present in the JSON item rows but is not rendered in human text.) For failed/blocked items `blockerKind`, `reason`, and `requestedHumanAction` are populated; for readiness-held items `blockerKind` is `readiness` and `requestedHumanAction` is `"refine <ticketId> then resume — <refinementProposal>"`; for dependency-held items `outcome` is `held` with a `reason` explaining which blocker triggered the hold. The `readiness` field (`{ outcome, gaps, refinementProposal }` evaluated live from the current ticket body; `null` when the ticket cannot be read) is present in both `show` and `report` item JSON.
- Every item also carries its [execution lane](#execution-lanes): a `lane: <lane> — <laneRationale>` line is printed beneath each item's summary row. If the item is blocked on `blockerKind: lane_escalation`, an additional line reads `LANE ESCALATION: item outgrew its approved lane — the whole campaign is paused pending re-approval of a new plan basis` (see [Lane escalation](#lane-escalation)). The JSON item rows carry `lane`, `laneRationale`, and `materialLaneAssumptions` fields for every item (`show`'s human text does not render `materialLaneAssumptions` directly; `report`'s does — see Report below).
- For a scope-blocked item (`blockerKind: scope`) refused specifically on a missing or failed host-verification gate, human text also prints a `host-verification-status: <text>` line rendering the `host_verification_not_recorded` / `host_verification_recorded_but_failed` distinction (see [Reconcile](#reconcile)) in operator-facing terms — "will be captured automatically" vs. a genuine failure. The same text is exposed as the `hostVerificationReconcileHint` field in JSON item rows (`null` when not applicable).
- A `Next action` line with the recommended operator step (`approve`, `start`, `resume`, `complete — none`, etc.). When a readiness-held item is the only hold, the line reads `refine <ticketId> then resume`; when a failed/blocked item needs resolution first, the line reads `resolve blocker <ticketId> (<blockerKind>) then resume`, with a ` — transient: \`forge campaign retry <campaign-id> <ticketId>\` will reset it` suffix when the item's `blockerKind` is `auth`/`infrastructure` (see [Retry](#retry)). When a campaign item is parked at a workflow gate or red block (`awaiting_gate` or `blocked_by_red`), Forge first checks whether that item was actually delivered outside the feature pipeline (see [Reconcile — out-of-band completion](#reconcile)); if the evidence-gated check is satisfied the line reads `<ticketId> delivered out-of-band — eligible for evidence-gated completion via forge campaign reconcile` instead of the generic gate text. Otherwise the line surfaces that item's `requestedHumanAction` — for example, `Human gate required at step verify in workflow feature` or `workflow blocked by failing verdict at step build`. When a campaign item is genuinely stuck in a non-resumable in-flight state and the campaign is `paused` (or `running` with a non-running in-flight item), the line instead reads: `recovery needed: item <ticket-id> is <lifecycle-status> — inspect run <run-id> (forge show <run-id>); if it turns out to be a transient failure (auth/infrastructure), \`forge campaign retry <campaign-id> <ticket-id>\` once the campaign is paused will reset it for a clean re-dispatch` (when no `run_id` is recorded, it reads `inspect the run (forge show)` instead — see [Retry](#retry)). When the source plan can no longer be resolved (e.g. a source ticket was deleted from the backlog since planning), the line reads: `plan can no longer be resolved (a source ticket may have been deleted) — re-plan with forge campaign plan`. Both `show` and `report` render the full persisted campaign and item state without error in this case; `start` and `resume` refuse non-zero with stop reason `plan_unresolvable`.

  This out-of-band-completable check is evaluated independently for every parked item, not just the one `Next action` names (FG-444): each item's JSON row carries an `outOfBandEligible` boolean, and human text prints an `out-of-band-eligible: <ticketId> delivered out-of-band — eligible for evidence-gated completion via forge campaign reconcile` line beneath any eligible parked item. `Next action` itself still names only one recommended next step — when a paused campaign has several concurrently-parked, eligible items, check each item's `out-of-band-eligible:` line (or `outOfBandEligible` field) to find all of them, not just the one `Next action` surfaces.

  A failed item parked `blockerKind: campaign_system` gets the same treatment (FG-502): each item's JSON row also carries a `campaignSystemEligible` boolean, and human text prints a `campaign-system-recoverable: <ticketId> delivered out-of-band — eligible for evidence-gated completion via forge campaign reconcile` line beneath any eligible one — same evidence bar and same hint text as `outOfBandEligible`, just routed off the `campaign_system` shape (see [Reconcile — Shape 3](#reconcile)). When a `campaign_system`-blocked item is the one `Next action` names, this eligibility is also checked before falling back to the generic blocked-item guidance text.

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
      "outOfBandEligible": false,
      "campaignSystemEligible": false,
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
- `safetyToContinue` — `can_start`, `can_resume`, `needs_resolution`, `dry_run_not_executable`, `running`, `needs_approval`, `stale`, `recovery_needed`, or `terminal`. `needs_resolution` means operator intervention is required before the campaign can resume — either a failed/blocked item (`lifecycleStatus: failed`, `outcome: blocked`) must be resolved, or an unrefined readiness-held item (`lifecycleStatus: pending`, `outcome: held`, `blockerKind: readiness`) must be refined; `can_resume` means neither condition is present. `dry_run_not_executable` means the campaign is in `dry_run` mode and cannot be started. `stale` covers two conditions: the plan hash changed since approval (`stale_plan`), or the plan can no longer be resolved at all because a source ticket was deleted from the backlog since planning (`plan_unresolvable`) — both require re-plan and re-approve. `recovery_needed` is returned when a campaign has an item in a genuinely stuck in-flight state (e.g. `running`, `awaiting_red`); items with `lifecycleStatus: awaiting_gate` or `blocked_by_red` are valid parked workflow states and do not trigger `recovery_needed` — the campaign can be resumed and the driver reattaches to the parked item. `forge campaign resume` refuses with `recovery_needed` only for genuinely stuck items that must be reset manually. (This `safetyToContinue` field reflects persisted state, evaluated fresh on each call — it is distinct from the transient `stopReason: recovery_needed` a `start`/`resume` call itself can exit with when the drive loop's no-progress bound trips mid-run, FG-488; that park lands in the ordinary `awaiting_gate`/no-`blockerKind` shape, so a subsequent `campaign show` reports `can_resume` for it, not `recovery_needed` — see [Start](#start-sequential-execution).)
- `dirtyGitState` — `git status --porcelain` output from the campaign's `projectDir` with host-local operational noise lines (`backlog/notes.md`, `.forge-scratch/`) removed, or `null` if nothing remains after filtering
- `groupings` — items bucketed by outcome: `shipped`, `blocked`, `held`, `skipped`, `failed` (items with `outcome: needs_refinement` are counted in `failed`)
- `deferredScope` — always `[]` (reserved)
- `followUpTickets` — always `[]` (reserved)
- `nextOperatorAction` — narrative next step for the operator. On a `paused` campaign with a failed/blocked item, names the blocking ticket and its `blockerKind` (e.g. `resolve blocker FG-5 (git_state) then resume`) — unless that item is `blockerKind: campaign_system`, in which case (FG-502) it first checks the same shape-3 out-of-band-completable evidence `show` previews via `campaignSystemEligible` (see [Reconcile](#reconcile)), naming the reconcile path when eligible before falling back to the generic blocked-item text; when blockers are resolved but a readiness-held item remains, prompts `refine <ticketId> then resume`; when blockers are resolved and only dependency-held items remain, prompts `resume — N held items will be reconsidered`. When a campaign item is parked at a workflow gate or red block (`awaiting_gate` or `blocked_by_red`), this checks the same out-of-band-completable evidence as `show`'s `nextAction` (see [Reconcile](#reconcile)) before falling back to `requestedHumanAction` — e.g. `FG-422 delivered out-of-band — eligible for evidence-gated completion via forge campaign reconcile`. On a `complete` campaign where shipped items have unresolved done-audit gaps, names the concrete operator steps (e.g. `shipped items have unresolved done-audit gaps — run host typecheck + full suite, record the result, then re-audit`).
- Per-item: all show item fields (including `readiness`, `hostVerificationReconcileHint`, `outOfBandEligible`, and `campaignSystemEligible` — see Show above), plus a `commit` field (the ticket's `closed_commit` for shipped items), `doneAuditState` (see below), `hostVerificationDetail` (the `detail` string from the `host_verification` check in `doneAuditState` when evidence was recorded, `null` otherwise — a different field from `hostVerificationReconcileHint`: `hostVerificationDetail` is done-audit's covering-row evidence detail, `hostVerificationReconcileHint` is reconcile shape-1's not-recorded/failed hint — both now resolve via the same ancestry-and-base-reachability coverage rule, so the two fields differ in which surface renders them, not in matching semantics), `branch` and `worktreePath` (populated when the campaign item ran in a Forge-managed worktree — see [Git discipline (v1)](#git-discipline-v1); `null` otherwise), null placeholders for `prUrl`, `verificationState`, `reviewerResult`, and the following workflow traceability fields: `executionMode` (the label for the lane's underlying dispatch mechanism — `"workflow"` for `full_feature`, `"invoke chain (engineer -> test-engineer)"` for `quick_implementation`, `"invoke (escape hatch)"` for `docs_only`/`test_only`/`review_only`/`research_only` and the legacy manual override, `"no dispatch"` for `ticketing_only`/`manual`), `workflowName` (the configured workflow name, e.g. `"feature"`; `null` except for `full_feature` items), `agentRole` (the agent role for invoke items; `null` otherwise), `taskSummaries` (array of `{phase, agentRole, status}` for each task in the item's run), and `verdictSummaries` (array of `{taskId, phase, verdict, authority, findingsCount}` for each verdict in the item's run). The human text rendering matches show (including the `lane:`/`LANE ESCALATION:` lines described above), plus a `lane-assumptions: <...>` line when `materialLaneAssumptions` is non-empty (report-only — `show`'s human text does not print this line): per item, `requestedHumanAction` is rendered as `action: <text>` when set, readiness outcome/gaps/refinementProposal are printed for items whose readiness is `needs_refinement` or `blocked` or that are readiness-held, a `host-verification-status:` line is printed when `hostVerificationReconcileHint` is set, the done-audit outcome is printed for each item (when outcome is not `pass`, gaps and `requestedAction` are also printed), `branch=` and `worktree=` are appended to the item line when set, and execution is printed per item (`execution: <label>`, with `[workflow=...]` or `[role=...]` where applicable) alongside task/verdict summaries.

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

**Liveness before evidence (FG-485).** An `awaiting_gate` item with no `blockerKind` and a `runId` on record doesn't only mean the item was driven to completion manually, outside the loop — it can also mean the operator decided the gate in-run (`forge gate <task> request-changes` or `advance`) and then called `resume` while the run itself is still `active` with real dispatchable work (a pending replacement primary after `request-changes`, or the next phase after `advance`). Before touching ship evidence at all, resume checks liveness: if the run is a pipeline run (has a loadable YAML workflow, i.e. `taskHasPipelineFinalize`), its status is `active`, and `computeReadyQueue` over that workflow finds a dispatchable step, resume skips evidence entirely for this pass and falls straight through to `driveWorkflowItem`, re-entering the drive loop directly. No `campaign_item.evidence_reconcile_refused` event and no "refusing to ship and re-parking" message fire in that case. If that live run's workflow fails to load, resume returns `recovery_needed` and pauses the campaign directly — a load failure never falls into the evidence path either. Invoke-family runs (`invoke`/`invoke_chain`, which have no loadable YAML workflow and no drive loop to re-enter) always skip the liveness probe and go straight to evidence, exactly as before FG-485. Only when the run is absent, not `active`, or `active` but settled with nothing left for `computeReadyQueue` to dispatch does resume fall back to evidence-reconciling the item.

**Evidence-reconciling a manually-driven item (FG-441, unified with reconcile by FG-460; reserved for non-live runs by FG-485).** When the liveness check above doesn't apply or finds no dispatchable work, resume evidence-reconciles the item — `lifecycleStatus: awaiting_gate`, no `blockerKind`, and a `runId` on record — using the SAME shared out-of-band composition as reconcile's shape 2 (see [Reconcile](#reconcile)): `evaluateOutOfBandEvidence` (ticket `done`, `closedCommit` reachable on the base branch, and lane evidence — either the closing commit is docs-only, or a passing host-verification row already covers it) composed, via `composeOutOfBandEligibility`, with the run's own authoritative-outcome fact (`authoritativeOutcomeContribution`, derived from `evaluateReconcileEvidence` but filtered to just the fail and inconclusive authoritative-outcome codes — FG-431 added the inconclusive-vs-fail split, FG-473 narrowed the filter to drop the missing-verdict code — so an unresolved fail or inconclusive verdict on the run surfaces as `run_evidence:<code>`, while a run with no authoritative verdict at all — the normal shape for an invoke-lane run (`quick_implementation`/`docs_only`/`test_only`/etc., which has no red step) — is no objection, and the lane evidence below is what vouches for that work instead). The one thing resume deliberately omits is reconcile's host-verification **capture** step: resume never runs a real host gate. Because both paths feed the same two evaluators into the same composition function, they cannot reach opposite verdicts for the same evidence — resume now ships a docs-only (`non_code_diff` lane) item with a clean authoritative outcome exactly as reconcile would, still refuses an unresolved authoritative fail, and — because it never captures — still refuses any code-touching item that lacks an already-passing host-verification row (`lane_evidence_missing`; resume never starts shipping un-verified code). Such an item can have been driven to completion entirely outside the resume loop — merged, closed, host-verified — while it still sits parked at its workflow gate; previously resume re-parked it forever, and for the docs-only case it disagreed with what `forge campaign reconcile` would have shipped (the FG-460 divergence). Eligible → the item is atomically marked `complete`/`shipped`, a `campaign_item.evidence_reconciled` audit event is recorded, and dependents held only on this item are released. Ineligible → resume refuses to ship it and falls through to the unchanged re-park, reporting the missing facts to stderr and as a durable `campaign_item.evidence_reconcile_refused` audit event — never an optimistic ship.

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
| `recovery_needed` | Either (a) one or more campaign items are in a non-resumable in-flight state (`running`, `awaiting_red`, etc.) before dispatch even begins — `awaiting_gate` and `blocked_by_red` are valid parked workflow states and do not trigger this precondition check — campaign stays `paused`, no dispatch occurs; or (b) the drive loop's no-progress bound (FG-488) trips mid-run — see [Start](#start-sequential-execution) — in which case the item ends this call parked `awaiting_gate` (no `blockerKind`) and the campaign is `paused` | For (a): inspect the stuck item with `forge campaign show <id>` (the `Next action` line names the ticket, its lifecycle status, and `run_id`) — if it turns out to be a transient (auth/infrastructure) failure, `forge campaign retry <campaign-id> <ticket-id>` (see [Retry](#retry)) resets it to `pending` for a clean re-dispatch; any other blocker needs re-plan or abandon. Then resume. For (b): inspect the run named in the item's `requestedHumanAction` (`forge show <runId>`), resolve the blockage, then `forge campaign resume` again |
| `drive_error` | The drive path itself threw mid-resume — FG-490, the same catch-and-park mechanism as `start` (see [Start](#start-sequential-execution) for the full mechanics and the JSON shape) | For a `runNext`-throw (item parked `awaiting_gate`): resolve the issue, then `forge campaign resume <id>` again. For a `startRun`-throw (item parked `failed`/`blocked`/`infrastructure`): `forge campaign retry <campaign-id> <ticket-id>` (see [Retry](#retry)) once paused, then `forge campaign resume <id>` again |
| `lane_escalation_unresolved` | An item is blocked on `blockerKind: lane_escalation` (FG-442) — a bare resume can never silently continue past an item that outgrew its lane | Run `forge campaign escalate-lane <id> <ticket-id> --new-lane <lane> --rationale <text>`, then `forge campaign approve`, then resume — see [Lane escalation](#lane-escalation) |
| `already_running` | Concurrent `resume` won the CAS | Wait or investigate |
| `paused` | Driver stopped cooperatively (SHARED blocker or held items remain) | Run `forge campaign resume` again after resolving any blocker |
| `complete` | All items processed | None |

### Retry

`forge campaign retry <campaign-id> <ticket-id> [--json]` (FG-489) resets a single transiently-failed campaign item back to `pending` — a clean per-attempt state, ready for the next `forge campaign resume` to re-dispatch it through the normal drive path. This is the supported replacement for hand-editing the database to un-stick a failed item; recovery guidance (see [Start](#start-sequential-execution), [Resume](#resume) stop reasons, and `show`/`report`'s `Next action` line above) names this verb instead of a manual DB reset.

**Eligibility** — all of the following must hold, or `retry` refuses non-zero with a reason naming which check failed:

- The campaign must be `paused`. Refused on `running` (a live driver owns the item) or any terminal status (`complete`, `failed`, `abandoned`).
- `ticket-id` must name an item that actually belongs to the campaign.
- The item must be currently failed: `lifecycleStatus: failed` and `outcome: blocked`. An item in any other state (e.g. still `pending`, `running`, or already `complete`) is refused.
- The item's `blockerKind` must be `auth` or `infrastructure` — the transient, host/environment failure kinds (`auth_missing`/`auth_expired`/`auth_injection_failed`; `container_crash`/`orphaned`/`idle_timeout`/`result_missing`/`result_malformed`/`work_not_persisted`/`integration_gate_timeout`/`integration_gate_crashed` — see `classifyFailureKind` in `src/campaign/policy.ts`). Any other `blockerKind` is refused with guidance rather than a silent retry:
  - `blockerKind: scope` (or any non-transient kind) — refused; the item did run and produced a concrete, operator-fixable result, so retrying it unmodified would just reproduce the same failure. Inspect it, then re-plan or abandon.
  - `blockerKind: lane_escalation` — refused, naming `forge campaign escalate-lane <campaign-id> <ticket-id> --new-lane <lane> --rationale <text>` instead (see [Lane escalation](#lane-escalation)).
  - A scope/verdict-blocked item is never silently retried over a red verdict — that would re-burn the item with no operator signal that anything about the failure actually changed.

**What it does.** On success, `retry` clears the item's per-attempt state — `outcome`, `blockerKind`, `continuePolicy`, `reason`, `requestedHumanAction`, `runId`, `branch`, `worktreePath`, and `prUrl` are all reset — and sets `lifecycleStatus: pending`. The transition is CAS-guarded against the campaign; if the campaign is no longer `paused` by the time the write lands (a concurrent status change), `retry` refuses rather than applying a stale reset.

**Relationship to resume.** `retry` only resets the item — it does not dispatch any work itself and does not change the campaign's status. Run `forge campaign resume <campaign-id>` afterward to actually re-drive the item (and any other pending items) through the normal dispatch path.

With `--json`:

```json
{ "campaignId": "camp-abc123", "ticketId": "FG-101", "lifecycleStatus": "pending" }
```

Auto-reset on `resume` is deliberately not implemented — re-burning a still-transiently-blocked item with no operator signal was rejected as a scope decision at filing (FG-489). `retry` is always an explicit, named step.

### Abandon

`forge campaign abandon <id> [--json]` moves a campaign to the terminal `abandoned` state. Irreversible.

Any `planned`, `running`, or `paused` campaign can be abandoned. Abandoning a `running` campaign takes effect cooperatively with the driver — the in-flight item completes before the driver stops, but the campaign status transitions to `abandoned` immediately.

`complete`, `failed`, and `abandoned` campaigns cannot be abandoned (they are already terminal). The command exits non-zero with the current status.

With `--json`:

```json
{ "campaignId": "camp-abc123", "status": "abandoned" }
```

### Reconcile

`forge campaign reconcile <campaign-id> [--by <operator>] [--json]` is an on-demand, non-destructive operator recovery command covering three distinct wedged-item shapes. Not the same as [Crash recovery](#crash-recovery-mvp-limitation), which repairs genuinely stuck in-flight items (`running`, `awaiting_red`) via manual SQL — reconcile is for items already parked in a terminal-ish shape that durable evidence shows are actually shipped. Reconcile takes no evidence argument of any kind in any shape; `--by` is attribution only and is never treated as evidence — every fact is re-read from durable Forge/git/backlog/host-verification records.

**Shape 1 — stale historical red-fail** (`blockerKind: scope`, `lifecycleStatus` of `failed` or `blocked_by_red`): for example, a `fail/authoritative` verdict that was later fixed, re-reviewed with a `pass/authoritative`, force-advanced with rationale, merged, host-verified, and closed, but the item still shows `outcome: blocked, blockerKind: scope`. Since FG-427 the drive path's own terminal-outcome reconciliation resolves the same effective-latest-state-per-task via the shared evaluator this shape's Fact 5 uses (below), so a run driven to completion no longer gets wedged this way in the first place. Shape 1 remains the recovery path for an item already wedged — from before that fix, or any other cause — since `resume` never retries a `blockerKind: scope` item on its own (see "Wedged on a stale historical fail" under [Start (sequential execution)](#start-sequential-execution), above).

**Shape 2 — delivered outside the feature pipeline** (`lifecycleStatus: awaiting_gate`, no `blockerKind`): either the item's ticket was re-routed to a non-pipeline lane (e.g. documentation-only work) and its feature run was intentionally parked at a human gate rather than driven through engineer+test-engineer, or (FG-442, tightened by FG-483) it dispatched through an invoke-based lane whose agent(s) finished without drive-time's evidence composition evaluating `eligible` — closed-with-`closedCommit` alone no longer suffices; the commit must be reachable on base and, if code-touching, already covered by a passing host-verification row (see [Outcome semantics](#start-sequential-execution) under Start, above). `executor.ts`'s `gate:human` path and its invoke-lane finalize sites are the only producers of `awaiting_gate`, and neither sets `blockerKind` — that absence is exactly what routes an item to this shape instead of shape 1.

**Shape 3 — campaign_system recovery** (`blockerKind: campaign_system`, `lifecycleStatus: failed`; FG-502): the campaign-level SHARED `campaign_system` default (see [Blockers and continuation](#blockers-and-continuation)) parked the item — one of `executor.ts`'s own salvage/gap/fallback producers (a non-`complete` run status, a done-audit gap after a passing verdict, or the conservative fallback when no failed primary task classifies to a more specific LOCAL kind) — but the ticket was actually delivered out-of-band despite that campaign-side failure. Reconcile evaluates this shape against the *identical* evidence bar as shape 2 (same evaluators, same run-evidence-agreement composition, same automatic host-gate consideration) — the only difference from shape 2 is the item's own `lifecycleStatus`/`blockerKind` combination that routes it here instead. Before FG-502, a `campaign_system`-blocked item had no ship path short of `forge campaign abandon`, even when it had genuinely shipped.

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
| `latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance` | Resolved per reviewing task (FG-427), not by a single run-wide highest-id: within each task that has an authoritative verdict, the highest-id event among {authoritative verdicts} ∪ {qualifying force-advances} is a `pass` or a qualifying force-advance (`decision: advance, force: true`, non-empty rationale) — an unresolved fail on any one task still blocks even when another task's latest state is a pass or force-advance. Emitted when at least one losing task's highest-id event is a genuine `fail` verdict |
| `latest_authoritative_verdict_is_inconclusive_with_no_later_pass_or_force_advance` | Same per-task resolution as above, but (FG-431) no losing task's highest-id event is a genuine `fail` — every losing task instead resolves to `inconclusive` (`needs_human`, an unrecognized verdict, or the reviewer produced no verdict). Still refused — inconclusive is not evidence of shipping either — but no longer mislabeled as a fail |

`host_verification_not_recorded` and `host_verification_recorded_but_failed` are deliberately distinct codes (FG-440): the first means no real gate run has happened yet and one will be attempted automatically (see below); the second means the required gate already ran for real and failed — a genuine failure that must never be rendered as something to wait out. `forge campaign reconcile`'s human output and `forge campaign show`/`report` (`host-verification-status:` line, see [Show](#show) and [Report](#report)) render each code with this distinction; raw `--json` output always carries the unrewritten code.

**Automatic host-gate capture (FG-440, evidence reuse added FG-474, full tiered gate set FG-500).** Before evaluating shape-1 evidence for a scope-blocked item, reconcile checks whether a *covering* host-verification row already passed for the item's ticket at the configured `requiredHostGate`. A row covers the item when `closedCommit` is an ancestor of the row's tested commit **and** that tested commit is itself reachable on the base branch — not an exact-sha match, since the gate always runs at `projectDir`'s current HEAD, never a checkout of `closedCommit` itself. If no covering row has already passed, reconcile calls into the capture step (`runAndRecordHostVerification`, `src/campaign/reconcile-collect.ts`), which — before actually executing anything — first checks for the narrower, EXACT-sha covering evidence described in [Evidence reuse for the deterministic gate](#evidence-reuse-for-the-deterministic-gate-fg-474) above, for the current HEAD. As of FG-500, "the required gate" this whole capture step covers is `deriveRequiredGateList(projectDir, requiredHostGate)` — `requiredHostGate` alone, plus `npm run test:extended` when it's still the project default and the project's `package.json` defines that script (see [Evidence reuse for the deterministic gate](#evidence-reuse-for-the-deterministic-gate-fg-474) above); single-gate/custom-gate projects still derive a one-element list, unchanged:

- a passing `host_verifications` row already recorded at this exact HEAD sha, for **every** member of the derived gate list → reused as-is (`status: "reused"`), no exec, no duplicate row written;
- else every job of the project's matched CI workflow is green at this exact HEAD sha — not just the single paired `CI / test` job; a red, pending, or absent sibling job means no CI coverage (see [Whole-workflow requirement](#evidence-reuse-for-the-deterministic-gate-fg-474) above) → recorded as a fresh row with `source: "ci"` and `ci_url` set to the check's details URL, again with no exec; this whole-workflow-green evidence covers every list member on its own, since it already proves every job passed;
- else — no evidence, a different sha, a different command, an uncovered list member, a red/pending/absent sibling job, an enumeration failure, or a pending/failing/disagreeing check (fails closed) — it runs the required gate for real, in `projectDir`, at its current HEAD, recording one row per list member, in order, and stopping at the first failing member (a failing `test:extended` run blocks exactly like a failing `requiredHostGate` run; remaining members, if any, are never run):
  - It refuses to run a given member (and writes no row for it — the item resolves to `host_verification_not_recorded`) when the working tree is dirty or untracked, HEAD is not reachable on the base branch, that member has no matching `package.json` script, or the working tree/HEAD changed while the gate was running. An operator's uncommitted or off-branch state is never recorded as a tested result, and a skip is never a synthetic pass.
  - Otherwise it records the actual exit code for that member — `0` on a real pass, non-zero on a real failure, timeout, or crash, never fabricated — against the commit it actually tested (the run's real current HEAD, not `closedCommit`). Each member's `gate_name` and `command` are always that member's own command string (never another member's label), so a lesser command can never wear a stronger gate's label (the FG-419 gate_name spoofing vector, now enforced per list member).

This is a passing-row model, not a once-ever model: a historical covering failure never permanently blocks the item — a later real covering (or reused/CI-sourced) pass ships it. A force-advance gate decision (fact 5 below) is a separate, independent fact and is never read as host-gate evidence, and vice versa.

Capture happens only as part of `forge campaign reconcile` itself — not automatically during `forge campaign drive`/`resume` — so an item merged through forge with no recorded host-verification ships on the next `reconcile` call, without a manual `forge record-host-verification` step (and, since FG-474, without necessarily re-executing the suite at all if a covering host row or green CI check for the exact commit already exists).

**Shape 2 evidence.** Still does not consult the item's own run events for lane-delivery evidence — the delivering work happened outside that run, so its run's event/verdict history (present, absent, or failing) cannot substitute for real out-of-band delivery evidence. But when the item has a `runId`, reconcile also composes the run's own authoritative-review outcome (FG-458) — the same fact `forge campaign resume`'s FG-441 evidence-reconciliation checks for this exact shape (see above) — from two of the three authoritative-outcome codes in the shape-1 table: `latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance` and `latest_authoritative_verdict_is_inconclusive_with_no_later_pass_or_force_advance` (FG-431). The third, `no_authoritative_verdict_or_force_advance_event`, is deliberately excluded from this fold-in (FG-473): it's the normal shape of an invoke-lane run (`quick_implementation`/`docs_only`/`test_only`/etc. — no red step, so no authoritative verdict of any kind), and treating that absence as an objection wedged every such item's out-of-band completion forever even though it shipped on lane evidence. The two folded-in codes surface here as `run_evidence:<code>` and are evaluated before the lane-evidence capture gate below so an unresolved fail refuses without spending a gate run on it. An item with no `runId` was never attached to a run in the first place (the legitimate FG-443 out-of-band delivery case) and keeps the pure events-blind path. As of FG-460, this whole composition — lane evidence via `evaluateOutOfBandEvidence` AND the authoritative-outcome fact — is the SAME shared function (`composeOutOfBandEligibility`) that `resume`'s FG-441 reattach calls, so the two paths cannot reach opposite verdicts for the same evidence, including on the lane/host-verification axis for a docs-only item (previously tracked as the FG-460 divergence: resume demanded a host-verification row unconditionally and refused a docs-only item reconcile would ship — now resolved). The only asymmetry left between the two paths is the automatic host-gate **capture** step below: reconcile can turn a code-touching, not-yet-covered item into a covered one before evaluating, and thereby ship it; `resume` deliberately never captures — it never runs a real host gate — so it still refuses any code-touching item lacking an already-passing host-verification row. An item is marked complete only when ALL of the following hold:

| Missing-evidence code | Fact required |
|---|---|
| `ticket_status_not_done` | Ticket status (backlog record) is `done` |
| `ticket_closed_commit_missing` | Ticket has a `closedCommit` recorded |
| `closed_commit_not_reachable_on_base_branch` | `closedCommit` is reachable on the base branch (`git merge-base --is-ancestor`) |
| `lane_evidence_missing` | Either the closing commit touches only non-code paths (a conservative allowlist of `.md`/`.mdx`/`.txt` files — any code file, any diff against more than one parent, or any git error safe-denies), or, when it touches code, a covering host-verification row exists for the required gate — `closedCommit` is an ancestor of the row's tested commit, that tested commit is itself reachable on the base branch, and at least one such covering row exited 0 (a passing-row model: a historical covering failure does not block once a later covering row passes) |

**Shape 3 evidence (FG-502).** Identical to the shape-2 table above, evaluated by the same code path (`isCampaignSystemRecoverable` routes a `failed`/`blockerKind: campaign_system` item into the exact same evidence composition shape 2 uses — no separate table, no separate evaluator) — the only thing that differs between shape 2 and shape 3 is which `lifecycleStatus`/`blockerKind` combination routes the item there.

For all three shapes, the `closedCommit` value and the configured base branch are validated against a strict sha/ref pattern before being passed to `git`, so a hand-edited ticket field can never be used to inject a git option. All three shapes use the same coverage rule (FG-452): a row recorded against a later commit still counts as long as `closedCommit` is an ancestor of that commit and the commit is itself reachable on the base branch (see automatic host-gate capture, above), since the gate always runs at `projectDir`'s current HEAD rather than a checkout of `closedCommit`. Before FG-452, shape 2 required exact-sha equality while shape 1 was already ancestry-based; the two lanes now share one rule.

**On success**, the item's `lifecycleStatus` moves to `complete`, `outcome` to `shipped`, and its blocker fields clear. Shape 1 records a `campaign_item.evidence_reconciled` audit event; shape 2 records a `campaign_item.out_of_band_reconciled` audit event; shape 3 records a distinct `campaign_item.campaign_system_reconciled` audit event (FG-502) — kept separate from shape 2's event so the audit trail can tell "delivered via a re-routed lane" apart from "recovered from a campaign-system-side failure that turned out to already be shipped," even though both shapes evaluate the identical evidence bar. All three carry the derived evidence, `--by` attribution if given, and a timestamp, and all three supersede the stale/parked history without erasing it. Downstream items whose only blocker was the reconciled item are freed to dispatch on the next resume. Reconcile does not resume the campaign itself — it does not transition the campaign; run `forge campaign resume <campaign-id>` afterward to let the existing item-terminal transition move the campaign to `complete` once every item is terminal.

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

Example (shape 3, FG-502): a `full_feature` item's run finalized with no authoritative verdict on any task and no failed primary task to classify to a more specific LOCAL kind — `executor.ts`'s conservative fallback parks it `lifecycleStatus: failed`, `blockerKind: campaign_system`, pausing the whole campaign. The ticket, however, was actually closed with a `closedCommit` reachable on `main` and a passing host-verification row already covers it. `forge campaign reconcile <campaign-id>` re-derives that fact, ships the item with a `campaign_item.campaign_system_reconciled` audit event, and a following `forge campaign resume <campaign-id>` continues the campaign — before FG-502 this shape had no ship path short of `forge campaign abandon`.

Note (FG-502): before this shape existed, a `campaign_system`-blocked item could only ever resolve to `not_applicable` on `reconcile`'s per-item `status` output. It can now also resolve to `shipped` or `refused: <missing evidence>`, exactly like a shape-1/shape-2 item — the human and `--json` output shown below render this the same way regardless of which shape produced it.

**Per-item out-of-band eligibility (FG-444).** `Next action` / `Next operator action` still names only one recommended next step, but `show` and `report` also evaluate out-of-band-completable eligibility for *every* parked item independently, not just the one that line names: each item's JSON row carries an `outOfBandEligible` boolean, and human text prints an `out-of-band-eligible: <ticketId> delivered out-of-band — eligible for evidence-gated completion via forge campaign reconcile` line beneath any eligible parked item (see [Show](#show)). Reconcile itself has always evaluated every item in the campaign independently regardless of how many are parked.

FG-502 extended the same per-item preview to shape 3: a `campaignSystemEligible` boolean and `campaign-system-recoverable:` line for every `failed`/`blockerKind: campaign_system` item, evaluated by a routing predicate mirrored (not shared by import) between `report.ts` and `reconcile.ts`'s write path — see [Reconcile](#reconcile) for the shape-3 evidence bar.
