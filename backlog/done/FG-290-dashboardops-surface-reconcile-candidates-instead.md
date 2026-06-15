---
id: FG-290
type: story
status: done
title: "Dashboard/Ops: surface reconcile candidates instead of ordinary stale running"
---

**Closed:** 2026-06-05.

**Caught:** 2026-06-05 during Pixtron NBA dogfood. `task-engineer-de709d` wrote a valid `result.json` at 07:36 PDT, but the DB row stayed `running` until 09:24 PDT, when `forge show task-engineer-de709d --json` triggered `reconcileRun` and emitted `task.reconciled` with `reason: "container_gone_result_present"`. The live dashboard was not rendering incorrectly; it was faithfully showing stale DB state because the dashboard is read-only and does not reconcile.

**Why this matters:** a stale `running` task is operationally misleading in the exact surface meant to help the orchestrator understand live work. Forge already has a recovery primitive (`show/status/next` reconcile lifecycle state), but dashboard/ops currently cannot distinguish "actually running" from "DB says running, container is gone, result exists, needs reconciliation." That makes completed work look active for hours until some writable CLI lifecycle command happens to touch it.

**Read-only detection predicate:**
- DB task status is `running`.
- Task has a `container.started` event or manifest container name, proving it was containerized.
- Docker liveness probe for that container returns a clear "not found / no such container" result.
- `~/.forge/runs/<runId>/<taskId>/result.json` exists and parses as JSON.

**Required behavior:** dashboard and/or `forge ops check` should surface this as a reconcile candidate, not ordinary running. The dashboard must stay read-only: it should not call `reconcileRun` directly. The orchestrator can then run an authoritative lifecycle command (`forge show`, `forge status`, `forge next`, or a future explicit reconcile command) to perform the mutation.

**Conservative liveness rules:**
- Docker says running: keep showing ordinary running.
- Docker says no such container/object: classify as `reconcile_candidate`.
- Docker unavailable, daemon error, or ambiguous inspect failure: classify as `liveness_unknown`, not dead.
- Container gone + valid result: `container_gone_result_present` candidate, likely complete.
- Container gone + no valid result: `container_gone_no_result` candidate, likely orphan/failed.
- Container alive + result present: surface as anomalous, not terminal.

Acceptance:
- A synthetic dashboard/ops fixture with DB `running`, `container.started`, container gone, and valid `result.json` reports a reconcile candidate rather than healthy running.
- The Pixtron shape (`container_gone_result_present`) is encoded in the test name or fixture so this regression is recognizable.
- Ambiguous Docker failures do not produce dead/reconcile candidates.
- Detection is read-only: no task/run rows are mutated and no `task.reconciled` event is emitted by the dashboard/ops read path.
- The surfaced metadata includes the reason and an orchestrator-facing recommended action.

Relations: #214, #250, #285, `src/v2/reconcile.ts`, `dashboard/src/queries.ts`.