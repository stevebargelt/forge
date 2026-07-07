---
id: FG-492
type: story
status: active
title: "Container disappearance diagnostics: preserve causal evidence before calling agent processes killed"
created: 2026-07-07
---

## Problem

Forge and the orchestrator have repeatedly described failed agents as "killed" or "session harness killed" when the durable evidence usually proves only a narrower fact: a task container disappeared or stopped producing output without Forge recording a trustworthy terminal event.

Current FG-485 evidence shows the distinction matters:

- `task-build-0-70bc7e` in `run-fg-485-7bfcb2` had `container.started`, no `container.exited`, no result, and stdout cut off mid-stream after about 2m33s. That is container-disappeared-without-terminal-evidence, not proven harness kill and not long-running.
- `task-engineer-cb3534` in the same run had `container.started`, no `container.exited`, no result, dirty project-dir evidence, and stdout cut off while an internal test command was running after about 9m10s. It may be harness, Docker, sleep/wake, timeout, wrapper crash, agent crash, or external kill; Forge did not preserve enough evidence to decide.
- `task-build-31326e` was a fanout parent with no container. Counting it as a killed agent is misleading; it failed because its child disappeared.

This weak evidence creates folklore: operators and orchestrators infer a cause from symptoms, then repeat that cause in handoffs. The result is wasted debugging and misplaced fixes.

Related current symptom: a documentation-maintainer wait loop missed completion for about 11 minutes because it used `pgrep -f "[d]ocumentation-maintainer"` as its wait condition. The real maintainer had exited, but unrelated long-lived Codex/Claude processes still matched because their argv contained conversation text with the role name. This is not container disappearance, but it is the same evidence-quality class: process-name matching on a multi-agent machine is too polluted to be a source of truth.

## Goal

Make container/agent disappearance causally diagnosable. Forge should record enough terminal evidence that an operator can distinguish harness kill, Docker/container exit, OOM/exit-137, idle timeout, wrapper crash, laptop sleep/Docker daemon interruption, and plain missing-result behavior. When evidence is absent, Forge should say that explicitly instead of naming an unproven cause.

## Acceptance Criteria

- Every task container terminal path records durable container evidence when available: container id/name, startedAt, finishedAt, Docker exit code, signal if available, `OOMKilled`, Docker `State.Error`, and whether Forge observed a `container.exited` event.
- Reconcile's container-gone path records that no prior `container.exited` event existed when applicable, and captures best-effort Docker inspect/evidence before classifying the task.
- `forge show`, `forge status`, and `forge ops check` distinguish:
  - confirmed container exit with code/signal/OOM evidence;
  - container missing with no terminal event recorded;
  - fanout parent derived failure with no agent container;
  - result missing after clean container exit.
- Operator-facing text avoids unproven causal labels. It may say "container disappeared without terminal evidence"; it must not say "harness killed" unless evidence supports that.
- Add a debug/diagnostic mode or retention policy so abnormal containers/logs are retained long enough for investigation, e.g. keep-on-failure or keep-for-N-minutes. Do not require this in normal success paths.
- Add a diagnostic command or show section that summarizes the task's causal evidence and explicitly lists what evidence is missing.
- Monitoring guidance and operator surfaces prefer durable Forge state and unique artifacts over process-name matching. `pgrep -f <role|ticket|command text>` must not be documented or used as the wait condition for Forge-launched work; at most it is a debugging aid.
- Add tests/fakes for at least:
  - started container disappears with no exit event;
  - exited container has code 137/OOM evidence;
  - fanout parent failure is not labeled as a killed agent;
  - result missing after clean exit is not conflated with disappeared container.

## Investigation Checklist

Use this checklist for current incidents until the feature lands:

- Task id, run id, phase, lane/workflow kind.
- `task.created`, `task.started`, `container.started`, `container.exited`, and `task.failed` timestamps.
- Container name/id and whether Docker can still inspect it.
- `result.json` state: valid, empty, missing, malformed.
- Last stdout stream event and stderr tail.
- Failure kind and whether it came from attached exit or reconcile.
- Worktree/shared-project changed files.
- If the task was detached, the exact launched PID/pidfile, terminal log marker, result artifact, or Forge DB terminal state used to decide completion. Avoid role-name or ticket-text process matching.
- macOS sleep/wake/Docker Desktop events around the timestamp before concluding "harness killed".

## Related / Consolidation

- FG-455: broad killed-wrapper/orphaned-task recovery work. Closed; it improved recovery and classification after loss, but did not make the original cause reliably diagnosable.
- FG-461: attached-exit `oom_killed` and related recovery evidence. Closed; it records evidence for some attached-exit abnormal kinds, but does not solve missing terminal-event/root-cause attribution.
- FG-491: persistence watchdog false positive. Active but separate: it is about a complete task being incorrectly downgraded to `work_not_persisted`, not a disappeared container.
- FG-437: provisioning-phase crash recovery. Related container lifecycle area, but specific to dependency provisioner containers rather than task agent containers.
- FG-173 / FG-185 historical work: idle watchdog/reaper lineage. Reference for prior lifecycle/reaper semantics, but do not reopen unless current evidence maps directly.

## Non-Goals

- Do not solve all Docker Desktop instability.
- Do not change retry/recover semantics except where operator text needs better evidence wording.
- Do not assume laptop sleep, harness reaping, or OOM as the cause without recorded evidence.
