---
id: FG-548
type: story
status: done
title: "store: deferred write transactions hit SQLITE_BUSY under multi-process WAL (snapshot upgrade bypasses busy_timeout)"
created: 2026-07-13
closed: 2026-07-14
closed_commit: 5bb675b
---

## Problem

Two concurrent forge processes finalizing DIFFERENT runs against one shared DB can crash one of them: `completeRun` (src/store/runs.ts:152, via finalizeRunIfSettled) wraps a read-then-write in a DEFERRED better-sqlite3 transaction. Under WAL, upgrading a deferred read snapshot to a write after another process has committed throws SQLITE_BUSY immediately — `busy_timeout = 5000` does not apply to snapshot-upgrade conflicts.

Surfaced live by the FG-425 cross-process e2e regression (`src/v2/fg425-project-gate-lock.worktree.test.ts`, on the deliberately-unmerged branch `fix/fg425-project-gate-locking`): ~1 in 4 runs, `SqliteError: database is locked` at runs.ts:148 in one of two concurrently-finalizing drivers. reconcile.ts already documents this class ("A DB-layer throw (SQLITE_BUSY) when two forge processes reconcile the same…") and guards; run-finalize does not.

## Direction

Construction-level, not call-site: audit `getDb().transaction(...)` write paths and make multi-process-contended write transactions IMMEDIATE (`.immediate()` in better-sqlite3) so they queue on busy_timeout instead of failing the snapshot upgrade — or introduce one wrapped write-transaction helper that defaults to immediate. Candidates beyond completeRun: any read-modify-write txn reachable from two processes (finalizeRunIfSettled, gate writes, campaign item CAS wrappers).

## Acceptance Criteria

- [ ] Two processes concurrently finalizing different runs on one DB never crash with SQLITE_BUSY (regression: drive a cross-process harness without a retry shim)
- [ ] Write transactions on multi-process paths are immediate (or routed through a shared immediate-write helper); the choice is enforced by construction or test, not per-site convention
- [ ] No behavior change for :memory: test DBs

## Relations

- Surfaced by FG-425's cross-process harness. FG-425's original process-supervision branch is unmerged/abandoned; this bug is independent of that design and stands on its own.
- Correctness; parallel-lanes-adjacent (FG-396).
