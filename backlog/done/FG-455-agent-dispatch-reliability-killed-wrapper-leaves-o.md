---
id: FG-455
type: story
status: done
title: "Agent dispatch reliability: killed wrapper leaves orphaned task with persisted work and no result"
created: 2026-07-03
closed: 2026-07-04
closed_commit: 4b663fd
---

## Problem

Since 2026-07-02/2026-07-03, Forge has repeatedly reported a pattern like: The build dispatch wrapper was killed again; the forge process may have completed or persisted regardless. This is not a normal agent failure. The wrapper/orchestrator can lose the task while the agent may already have modified the worktree.

Concrete current incident: FG-442 run run-campaign-execution-lanes-fg-442-f7ca3f.

Observed evidence:

- forge show run-campaign-execution-lanes-fg-442-f7ca3f reports failed/orphaned child task-build-0-19c2a9 and active parent task-build-8f2e94.
- Timeline has container.started for task-build-0-19c2a9 but no corresponding container.exited.
- The task result.json is empty.
- The task container.stderr.log is empty.
- The task container.stdout.log contains substantial agent activity, so real work happened.
- The project worktree contains persisted FG-442 edits after the orphan: src/campaign/planner.ts, src/campaign/policy.ts, src/campaign/policy.test.ts, src/cli/commands/campaign.ts, src/types/index.ts, and new src/campaign/lane-classifier.ts.
- docker ps did not show an active Forge container afterward.

This creates an unsafe operational ambiguity: Forge cannot tell whether the agent failed, the host wrapper died, Docker killed the container, an idle/OOM/SIGKILL happened, or useful work persisted and should be verified rather than retried.

## Additional forensics (2026-07-03 orchestrator session)

**This is TWO distinct failure modes with different signatures — the fix must handle both:**

- **Mode A — direct `forge invoke` (DETACHED container).** The wrapper is killed at the harness cap, but the agent container detaches and runs to completion. Work persists FULLY, the run is marked `complete` — but `result.json` is written EMPTY. Seen 3x this session (FG-452 fixes): run shows `complete`, all target files modified on disk, `container.stdout.log` tail shows the agent mid/post-validation, yet `result.json` is 0 bytes. Net: a FALSELY-`complete` run with no structured result.
- **Mode B — pipeline `forge next` (ATTACHED container).** `forge next` runs the phase attached and blocks; killing the wrapper kills the attached container → `task.failed {container_gone_no_result}` → orphaned with PARTIAL work (some plan files edited, others untouched). This is the FG-442 incident above. The distinguishing variable is container lifecycle: `forge invoke` detaches and survives; pipeline `forge next` is attached and dies with the wrapper.

**Root cause of the empty-result ambiguity (likely):** `result.json` at the task dir appears to be populated by a wrapper-side finalize/copy-out step that runs AFTER the container exits — not by treating the container's own `/task/result.json` (which the agent seed is required to write) as authoritative. When the wrapper dies, finalize is skipped and the result is empty even though the container succeeded and its in-container result exists. Candidate direction: reconcile should read the container's own written result (mounted `/task/result.json`) as the source of truth rather than depending on a wrapper finalize; verify whether the lost step is the copy-out.

**Timing signature:** the kill is a DURATION threshold, not random. Short phases (<~5 min: architect ~4.5 min, tech-lead ~2–5 min) never hit it; the FG-442 build child ran 21:32:16 → 21:44:55 (~12 min 40 s) before `task.failed`. Consistently ~10–12 min of wrapper wall-clock (harness background-command cap). Any single dispatch expected to exceed ~10 min is at risk.

**Recovery-primitive footguns discovered (directly relevant to the fanout-parent + recovery-command ACs):**

- `forge cancel <fanoutParent-task>` marks the ENTIRE run `abandoned` (terminal — no resume/revive command exists), not just that task. On FG-442 this destroyed the run shell (architect + plan tasks survived as `complete`, but the run could not continue).
- `forge retry <failed-fanout-child>` creates a NEW pending task with `parent_id=None`, detached from the fanout parent; `forge next` then dispatches nothing coherent (the still-`running` parent blocks it). Retrying individual fanout children does not re-drive the wave.
- Net: today there is NO clean in-run recovery for an orphaned fanout build — the available primitives make it worse. This is the gap the "fanout parent reconciled / operator-safe recovery command" ACs must close.

**Existing persisted-work heuristic is already unreliable (opposite direction):** Forge's current FG-377 "work not persisted" check FALSE-POSITIVED this session on a different invoke (work WAS on disk via `git status`). So the new classification must not lean on that heuristic; verify against the actual worktree diff.

**Recovery workflow that actually worked this session (candidate for the documented recovery path):** (1) `git status` for the persisted diff; (2) tail `container.stdout.log` (stream-json) for the agent's last action and whether it self-validated; (3) if `result.json` is empty, reconstruct intent from the log; (4) run host `npm run typecheck` + `npm run test:all` to SUPERSEDE the missing agent self-validation; (5) review the diff at the gate before trusting it. This recovered 3 orphaned invokes cleanly.

## Goal

Make agent dispatch/container loss diagnosable and recoverable. A killed wrapper or orphaned container/task should produce a clear failure classification and an operator-safe recovery path that preserves useful persisted work without blindly retrying or losing evidence.

## Acceptance Criteria

- Forge distinguishes at least these cases in task/run evidence and operator output: host dispatch wrapper killed/lost; Docker/container exited non-zero; idle timeout; OOM/SIGKILL or exit 137 when detectable; agent produced no result.json; orphaned task with stdout/worktree evidence suggesting persisted work.
- Forge distinguishes the DETACHED-invoke case (container finished, work fully persisted, run falsely `complete` with empty result.json) from the ATTACHED-pipeline case (container killed with the wrapper, partial work) — they need different classification and recovery.
- When a task is orphaned but stdout or worktree changes exist, forge show/status surfaces a specific message: work may have persisted, with task id, task dir, changed files if available, and recommended recovery.
- Fanout parent state is reconciled after an orphaned child so the parent does not remain misleadingly active without a clear next step.
- `forge cancel <fanoutParent>` must NOT silently abandon the whole run without an explicit flag/confirmation; and there must be a supported path to re-drive an orphaned fanout build in-run (retrying a child must not strand a parent_id=None task).
- Prefer the container's own written result (mounted /task/result.json) as authoritative on reconcile, so a wrapper death after container success does not yield an empty result on a `complete` run.
- Provide an operator-safe recovery command or documented workflow to inspect persisted diff, run verification, and either continue from the diff or retry cleanly.
- Record container name, last known liveness, available Docker inspect/exit evidence, stdout/stderr/result presence, and changed-file evidence before classifying the task.
- Tests cover an orphaned task with empty result/stderr but non-empty stdout and worktree changes, ensuring Forge does not classify it as an ordinary implementation failure.

## Non-Goals

- Do not solve every Docker Desktop instability.
- Do not discard persisted work automatically.
- Do not make blind retries the default recovery for this class.

## Related

- Surfaced during FG-442 build dispatch.
- Adjacent to AWN-1 crash recovery and FG-437 provisioning-phase recovery, but this is specifically wrapper/container/task-loss classification and persisted-work recovery.
- Orchestrator-side mitigation already in memory this session: prefer direct `forge invoke` (detaches/survives) over the pipeline for long builds, and never cancel a fanoutParent expecting a per-task effect.

## Progress — 2026-07-03 overnight

**Piece 1 (merged, PR #12):** reconcile detects/recovers persisted work before orphaning a container-gone task.

**Pieces 2 & 3 (merged, PR #13 / merge 27ab422):**
- Piece 2 — reconcile a fanout parent stuck `running` after its children finish/die mid-wave (→ complete, or failed `fanout_wave_orphaned`, liveness-guarded); `forge cancel` kills fanout child containers and gates whole-run abandon behind `--abandon-run` (no more silent abandon).
- Piece 3 — new `forge recover <id>` (read-only inspect / `--continue` adopt-and-complete via `markTaskRecovered` with fail-safe refusals / `--re-drive` in-run fanout re-drive without stranding); `forge retry` refuses a fanout child/parent without `--force`; `forge show` recommends `forge recover --re-drive` for `fanout_wave_orphaned`. Red-wide reviewed; two HIGH findings fixed. Docs: concepts.md + FORGE-DEC-024.

**REMAINING — "piece 4" (keeps this ticket OPEN):** two ACs still unmet, surfaced by the piece-2/3 red review:
1. **OOM/SIGKILL / exit-137 classification** (AC "OOM/SIGKILL or exit 137 when detectable" + "record docker inspect/exit evidence"): `defaultContainerAlive` only reads `{{.State.Running}}`; nothing inspects `{{.State.ExitCode}}`/`{{.State.OOMKilled}}`, so an OOM/137 death is classified identically to any container-gone case. Fix: best-effort exit-code/OOM inspect on the gone branch, recorded in `OrphanEvidence`, distinct kind (e.g. `oom_killed`).
2. **Mode A — detached-invoke falsely `complete` with empty result.json** (AC "distinguish DETACHED from ATTACHED" + "prefer the container's own written result as authoritative so a wrapper death after container success does not yield an empty result on a complete run"): `reconcileRun` only revisits `status==='running'` tasks, so an already-`complete` task/run with an empty `result.json` is never backfilled from the container's own mounted `/task/result.json`. Fix: reconcile a `complete` task whose result.json is empty by reading the container's own written result.

Both are classification-completeness work (piece-1-adjacent), not part of the piece 2/3 cancel-fanout-recovery scope.
