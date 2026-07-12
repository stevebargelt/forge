---
id: FG-536
type: story
status: active
title: "harden agent execution against host-side parent death: docker-detached invoke (results survive any orchestrator/harness process kill by construction)"
created: 2026-07-12
---

## Problem

Agent containers die when their host-side parent process tree is SIGTERMed, because `forge invoke` runs `docker run` attached and the docker CLI proxies signals into the container. The 2026-07-11 forensics (session fff3e306) measured the blast radius: 11 of 59 harness background commands were killed by the Claude Code harness's background-task sweep (sender PROVEN by si_pid capture, FG-535; the TRIGGER is unestablished — the capture happened with the display ON, so user-away/lock/display-off is a correlate in the 2026-07-11 sample [9/11 kills during display-off, delays 15s–21m, no timeout pattern], not an established cause), each taking its agent container down mid-work. Every kill was recoverable from on-disk work, but recovery cost multiple orchestrator round-trips per incident and one engineer's result.json was lost entirely (empty file + false `complete` — the FG-374-era pattern).

The same attached-execution fragility underlies: the foreground Bash 10-min cap kills, external `timeout` kills, and `forge next`'s attached phase deaths (see the pipeline long-build memory). One fix closes the class.

## Fix shape (by construction, FG-516 lesson)

Run agent containers DETACHED (`docker run -d`) with the host-side CLI as a watcher, not a lifeline:

- `forge invoke` starts the container detached, records the container id on the task row, then WAITS (docker wait / poll) for completion and finalizes as today. If the CLI process dies mid-wait, the container keeps running, writes result.json, and exits normally.
- A reconcile path (largely existing: container-gone/needs-finalize handling, FG-479) finalizes tasks whose watcher died: container exited + result.json present → finalize through the real path (validation contract included, FG-523); the FG-530 crash matrix already covers most of these windows — extend it for the detached shape.
- The idle-watchdog (in-process today, dies with the parent) must move container-side or into reconcile, or a killed watcher leaves an unbounded container. Decide explicitly.
- reviewer/fixer dispatch in review-loop and runNext phases inherit the same detached execution.

## Acceptance Criteria

- SIGTERM/SIGKILL of the forge CLI process mid-invoke leaves the container running to completion; a subsequent `forge reconcile` (or the next forge command's sweep) finalizes the task with its REAL result through finalizePrimary/the validation contract — no empty result.json, no false complete. Regression test: kill the CLI (not the container) mid-run over the fake docker layer + one live smoke.
- The idle/runaway bound still holds with a dead watcher (documented mechanism + test).
- FG-530 crash-matrix registry gains the detached-execution kill points (watcher death between container-start and finalize).
- No behavior change when the watcher survives (parity tests on the normal path).

## Notes

Filed 2026-07-11 from the background-kill investigation (evidence: ~/.forge/sigterm-probe/, session transcript forensics, upstream #72851/#68625/#25188). Relates: FG-535 (owns launcher durability + Claude/Supacode attribution — its durable tmux launcher is the operational mitigation until this lands), FG-513 (resilience scope), FG-533 (pre-container window), the pipeline long-build memory. Until this lands, unattended dispatch should prefer setsid-detached parents.


## Validation evidence — live CLI-kill smokes (2026-07-12, detached executor live via linked source)

- Parity smoke: `forge invoke engineer` (run-fg-536-detached-exec-live-smoke-344dbd) ran DETACHED end-to-end on the normal path — detached-entry.sh + detached-stdin staged in the task dir, container ran, result ingested by the surviving CLI, task complete, container reaped.
- SIGKILL smoke (launch-fg536-kill2): forge CLI pid SIGKILLed ~9s after container.started — container observed still running after the kill, ran to completion, wrote result.json; reconcile finalized the task `complete` from the REAL result (events: container.started → container.exited exitCode 0 with evidence → task.completed). Launch record: terminated by SIGKILL (signal sender not recorded).
- SIGTERM-tree smoke (launch-fg536-kill3): the forge CLI AND its descendants SIGTERMed — the exact FG-535 harness-kill signature that used to exit containers 143. Container observed alive after the kill ("Up 9 seconds"), completed, reconcile finalized from the real result. Launch record: terminated by SIGTERM (signal sender not recorded).
- Idle bound with a dead watcher: reconcile-side enforcement (manifest budget, docker-kill + container.idle_timeout evidence, no same-pass status write, fail-safe on unknowable activity) pinned by fg536-idle-bound.integration.test.ts.

## AC clarification — "through finalizePrimary/the validation contract" (2026-07-12, review round)

The review pinned down what this AC line means against the ADR'd recovery architecture (FORGE-DEC-024/FG-479), which this ticket deliberately does NOT reverse:

- A PIPELINE step that finishes after its watcher dies lands as `orphaned_needs_finalize` with the real result preserved; the named `forge retry --force` re-drive runs the step through the REAL finalize path — merge, integration gate, reds, finalizePrimary, and the FG-523 validation contract. Reconcile never inlines finalizePrimary (adopting half-finalized state from reconcile was considered and rejected in FG-531/FORGE-DEC-024 — it would duplicate the trust path at a second site).
- An INVOKE-like task completes from the valid disk result exactly as the live invoke path would. The live invoke path carries no validation contract (FG-523's tests_run contract is a pipeline implementer-step gate via holdIfValidationContractFails) — recovery is at parity, neither stricter nor weaker. "No false complete" holds: only a valid structured result completes, with the container-gone evidence tuple on the record.
- The detached start record now carries the daemon's container ID (docker run -d stdout) alongside the name, so start evidence names the actual container identity, and container.started is recorded only after `docker run -d` succeeds (no phantom start on a failed launch).
