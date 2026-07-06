---
id: FG-377
type: story
status: done
title: "Persistence-check false-positive on macOS: settle/retry window before 'work not persisted'"
created: 2026-06-23
closed: 2026-07-06
closed_commit: 9fad83a3608be52275ed36f34b2ec7a623a88bce
---

**Priority: medium — infra/correctness (orchestrator reliability).**

## Problem

The agent persistence-check (FG-354 lineage) can FALSE-FAIL on macOS. An FG-375 engineer returned `status: failed` with "work not persisted: result.json reports status=complete with N modified files, but none exist on the host project dir — the agent likely wrote to an ephemeral container path." But `git status` on the host immediately afterward showed ALL the files present and complete (correct content, typecheck clean, command working). The agent HAD written to `/project` correctly; Docker Desktop's gRPC-FUSE / the DEC-019 shadow-volume bind mount synced the writes to the host slightly AFTER the persistence-check ran. The check observed the dir before the container's writes had flushed and declared the work lost.

## Goal

Eliminate the macOS false-positive in the agent persistence-check by adding a bounded settle/retry window, so a task whose writes land within the mount-sync window is NOT misreported as `failed: work not persisted`, while genuine misses (writes to `/workspace` instead of `/project`) are still caught. Restore trust in the persistence-check without materially slowing the common already-synced case.

## Impact

- A successful task is reported as `failed`, and the natural response (re-run) DUPLICATES/CONFLICTS with work that actually landed.
- Wastes a full agent round (it bit us once this session).
- Erodes trust in the persistence-check, which is otherwise a valuable guard (it correctly catches genuine /workspace-instead-of-/project writes).

## Fix sketch

Add a short settle/retry window before declaring "work not persisted": when the claimed `files_modified` are absent on the first check, wait briefly (e.g. a few hundred ms, a couple of retries) and re-stat before failing. Only fail if the files are STILL absent after the settle window. Consider an `fsync`/directory-resync nudge if cheap. Keep the genuine-miss detection intact (a real /workspace write will still be absent after settling).

## Acceptance Criteria

- A task whose files land on the host within the mount-sync window is NOT reported as "work not persisted."
- A task that genuinely wrote nothing to /project (e.g. wrote to /workspace) is still failed.
- The settle window is bounded and does not materially slow the common (already-synced) case.

## Notes

- Surfaced during FG-375 (2026-06-23). The error message already hedges ("if this task intentionally deleted every one of these files, this is a false positive").
- Operator workaround until fixed: on a "work not persisted" failure, `git status`/`ls` the claimed files on the host BEFORE re-running — if present and complete, the check false-failed; verify (host typecheck + full npm test) and use the work.
- Relates to FG-354 (persistence-check) and DEC-019 (node_modules shadow volume).
