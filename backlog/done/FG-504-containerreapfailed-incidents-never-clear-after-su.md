---
id: FG-504
type: story
status: done
title: container_reap_failed incidents never clear after successful repair; completed-leak sweep text claims swept on reap error
created: 2026-07-09
closed: 2026-07-09
closed_commit: e0c42c957115eeda73b555e4b18957b8b5439241
---

## Problem

Two incident-lifecycle/operator-text gaps in shipped FG-503 (operator review, 2026-07-09; the cleanup-safety invariant itself is sound):

1. **Sticky incidents.** src/ops/detect.ts:428 emits `container_reap_failed` solely from the latest durable `container.reap_failed` event. Nothing ever records a resolution — `forge ops reap-containers` writes no reaped/resolved event and the detector never consults disk truth — so after the operator runs the recommended repair successfully (container gone), `ops check` reports the stale incident forever.
2. **False "now swept" text.** src/cli/commands/ops.ts:162 adds completed-task leak containers to `completedTaskLeaks` even when `reap()` returns `"error"`, and ops.ts:272 then prints "leaked from a SUCCESSFUL task ... now swept" — false for the error case (fail-safe, but misleading).

## Goal

Running the recommended repair clears the incident, and the sweep output never claims success it didn't achieve.

## Design direction (not prescriptive)

Prefer keeping detect.ts pure-DB (no docker dependency in the poll path): have `ops reap-containers` record a durable resolution event (e.g. `container.reaped`) when its rm succeeds AND when it finds the container already gone (`not_found` = confirmed gone — the repair should clear the incident either way); the detector then treats a `container.reap_failed` as superseded by any LATER resolution event for the same containerName. Happy-path task-completion reaps stay silent (FG-503 AC4) — only the sweeper (the recovery path) records resolutions.

## Acceptance Criteria

- [ ] After `forge ops reap-containers` succeeds (reaped OR not_found) for a container with a prior `container.reap_failed` event, `forge ops check` no longer raises the `container_reap_failed` incident for it.
- [ ] A reap that returns `error` still raises/keeps the incident, and the sweep output for that container says it is NOT confirmed gone — the "now swept" wording is only used for confirmed-gone outcomes.
- [ ] Happy-path task-completion reaps record nothing new.
- [ ] Tests: incident clears after a successful sweep; incident clears after not_found; incident persists after error; output wording split (swept vs not-confirmed-gone) asserted in both plain and --json shapes.

## Non-Goals

- No docker calls inside ops check/detect.ts.
- No change to FG-503's retention or candidacy semantics.
