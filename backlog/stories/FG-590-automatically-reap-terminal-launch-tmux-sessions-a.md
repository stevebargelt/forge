---
id: FG-590
type: story
status: active
title: Automatically reap terminal launch tmux sessions and expired retained task containers
created: 2026-07-18
---

## Problem

Forge currently leaves lifecycle cleanup to the operator. After one long autonomous run on 2026-07-17, the host contained:

- 447 terminal `forge launch` records with retained tmux sessions;
- 25 stopped Forge task containers;
- zero running launches or containers represented by that inventory.

Clearing them required an explicit `forge launch rm` sweep and `forge ops reap-containers --all`. This creates unbounded host-state growth: tmux memory and process metadata, Docker Desktop/container metadata and disk use, and increasingly expensive dashboard, launch-list, doctor, and ops queries. It likely worsens host memory pressure during long runs.

The current diagnostics-retention policy is useful, but "retain indefinitely until the operator remembers to clean it" is not a safe lifecycle policy.

This is distinct from FG-549: FG-549 concerns stale `orphaned_work_may_persist` incidents. This ticket concerns automatically retiring terminal runtime resources and records.

## Required outcome

Forge automatically performs bounded, evidence-preserving cleanup after work becomes durably terminal. Successful work is retired promptly. Failed or ambiguous work remains inspectable for a defined retention window, then is retired automatically. A long autonomous run must not leave hundreds of dead tmux sessions or stopped containers indefinitely.

The implementation mechanism and exact default retention durations require a bounded design decision, but cleanup must not depend on an orchestrator remembering to issue periodic manual commands.

## Scope

- Terminal `forge launch` tmux sessions and launch records.
- Stopped Forge task containers retained for failure investigation.
- Automatic cleanup at safe Forge lifecycle boundaries and/or by a durable scheduled mechanism.
- Separate, operator-configurable retention policies for successful versus failed/ambiguous outcomes.
- Durable capture of authoritative exit/container evidence before destructive cleanup.
- Existing manual commands remain available for inspection, early cleanup, and repair.
- Idempotent, crash-safe cleanup and explicit reporting of cleanup failures.
- Dashboard/status/ops surfaces must distinguish retained-for-investigation resources from leaked or expired resources.

## Non-goals

- Do not delete running launches, running containers, or resources owned by non-terminal tasks.
- Do not weaken failure evidence, orphan reconciliation, retry safety, or FG-503/FG-504/FG-505 resolution semantics.
- Do not treat a raw container exit code alone as proof that the owning task is terminal.
- Do not redesign general run-history retention.
- Do not fold FG-549 into this ticket.

## Acceptance criteria

- [ ] A terminal successful launch is automatically detached from its tmux remains and its record is retired after the configured success retention period.
- [ ] A failed, signaled, owner-gone, or unknown launch remains inspectable for its configured diagnostic window and is then automatically retired.
- [ ] A running launch is never removed, including across a cleanup/process crash race.
- [ ] A stopped container whose task is durably terminal is retained according to outcome policy and automatically reaped after expiry.
- [ ] A running container or a container owned by a non-terminal task is never reaped.
- [ ] Before reaping a failed or ambiguous task container, Forge persists the available exit code, signal, OOM, timing, and missing-evidence facts needed by `forge show --diagnostic`; if required evidence cannot be persisted, cleanup fails closed and reports the resource.
- [ ] Cleanup is idempotent across process death between resource removal and durable resolution recording; a later pass converges without a sticky incident or fabricated success.
- [ ] Existing `forge launch rm` and `forge ops reap-containers` behavior remains available and consistent with the automatic policy.
- [ ] A regression test creates terminal launches and retained terminal containers across success/failure/unknown states, advances a fake clock past each retention boundary, and proves only eligible resources are removed.
- [ ] A scale regression representing at least 500 terminal launches plus 25 retained stopped containers proves one cleanup pass converges to only running and within-retention resources; cleanup work is bounded and does not repeatedly rescan already-resolved history without need.
- [ ] Operator-facing documentation states the default retention periods, configuration controls, evidence guarantees, and the command for an immediate manual sweep.
- [ ] Upgrade behavior supplies safe defaults without requiring every existing project to edit local configuration manually.

## Falsification cases

- Kill cleanup after deleting a tmux session but before recording resolution; the next pass must converge truthfully.
- Kill cleanup after deleting a container but before recording resolution; the next pass must use disk truth and converge truthfully.
- Race a terminal transition with cleanup; no still-running resource may be removed.
- Make evidence persistence fail; the failed/ambiguous container must remain and the cleanup failure must be visible.
- Re-run cleanup repeatedly; it must not recreate incidents, duplicate resolutions, or degrade with already-clean history.
