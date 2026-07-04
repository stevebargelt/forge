---
id: FG-437
type: story
status: done
title: "AWN-1 crash reconciler: model the FG-376 dependency provisioning phase (recover stranded task + orphaned forge-provision-* container after host crash mid-provision)"
created: 2026-07-02
closed: 2026-07-04
closed_commit: eb57b0f
---

## Problem

FG-376 added a two-phase dependency-cache flow: a dedicated short-lived provisioner container (forge-provision-<taskId>) installs into shared rw named volumes under a host-side lock BEFORE the agent container runs. The AWN-1 crash-recovery reconciler (src/v2/reconcile.ts) does not model this new provisioning phase. A host/orchestrator crash DURING provisioning can:
- strand the task at status=running (the reconciler does not recognize the provisioning-phase state), and
- leak an orphaned forge-provision-<taskId> container that nothing reaps.

The immediate corruption window (a second dispatcher stealing the provisioning lock and running a concurrent install into the same rw volume after an orchestrator-pid death) is closed separately in FG-376 by making lock-steal provisioner-container-liveness-aware. This ticket is the BROADER lifecycle-recovery piece: teaching the reconciler to detect and recover a task stranded in the provisioning phase.

## Goal

AWN-1 reconciliation recognizes the provisioning phase and safely recovers from a host crash during it — no permanently-stranded running task, no leaked provisioner container.

## Acceptance Criteria

- reconcile.ts detects a task that crashed during dependency provisioning (status=running with an in-flight/aborted provisioner phase and no live provisioner container) and transitions it to a recoverable state (retryable / failed with a clear reason), rather than leaving it running forever.
- An orphaned forge-provision-<taskId> container left by a host crash is detected and reaped (or explicitly reported) during reconciliation.
- If a provisioner container is still alive at reconcile time, reconciliation does not kill it out from under an in-progress install; it waits or defers, consistent with the FG-376 lock-steal liveness rule.
- The ready marker / lock state for the affected cache key is left consistent after recovery (no half-written marker treated as ready; no permanently-held lock from a dead holder).
- Tests simulate a host crash mid-provision and assert the reconciler recovers the task and reaps the orphan container.

## Refs

- src/v2/reconcile.ts (AWN-1 crash recovery)
- src/v2/dependency-provisioning.ts provisionDependencyCache, src/v2/spawn.ts buildProvisionerDockerArgs, src/util/run-lock.ts acquireFileLockBlocking (FG-376)
- Surfaced by the FG-376 round-3 red-wide re-check; FG-376 ships once the corruption window is closed, with this as the deferred lifecycle-recovery follow-up.
