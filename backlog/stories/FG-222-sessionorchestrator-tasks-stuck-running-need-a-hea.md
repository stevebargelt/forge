---
id: FG-222
type: story
status: active
title: Session/orchestrator tasks stuck 'running' need a heartbeat-based reaper (not container-based)
---

Surfaced during AWN-1 (#214): the real DB has several task-session-* (phase=session, role=orchestrator) tasks stuck status='running' from orchestrator/design sessions that ended without finalizing. AWN-1's reconcile deliberately SKIPS them (no container.started — they're host-side), so they stay 'running' forever and inflate forge status / dashboard "in flight".

These need a DIFFERENT reaper keyed on the orchestrator-heartbeat files (~/.forge/orchestrators/<session>.json, written by scripts/claude-hooks/orchestrator-heartbeat): if a session task is 'running' but its heartbeat file is absent or its lastSeen is stale (> threshold), finalize it (complete with "session ended" note, mirroring design.ts:138, or a session.reconciled event).

Scope: a heartbeat-staleness reconcile pass for session/manual (non-containerized) tasks, complementing AWN-1's container-liveness pass. Wire into the same lifecycle commands. Idempotent + audited like AWN-1.

Note: 5 such tasks were briefly mis-orphaned by an early AWN-1 build and restored from backup (forge.db.bak-20260530-084522-reconcile-restore); they remain legitimately stale and this ticket cleans them up properly.