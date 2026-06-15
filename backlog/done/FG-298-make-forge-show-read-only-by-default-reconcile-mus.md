---
id: FG-298
type: story
status: done
title: Make forge show read-only by default; reconcile must be explicit
---

**Closed:** 2026-06-05.

**Caught:** Pixtron dogfood, 2026-06-05. `task-engineer-b26b0f` showed `running` in the dashboard, but `forge show task-engineer-b26b0f --json` reconciled it to `complete` at the exact inspection timestamp (events 2049–2052 show `task.reconciled` firing precisely when `show` ran). **Second time today a diagnostic/read action changed task state** (the first: `forge usage` triggering the #295 migration on the live DB).

**Problem:** `forge show` calls `reconcileRun` before rendering, so an operator cannot inspect stale-`running` state without mutating it. A read command with a write side effect is surprising and unsafe, and it directly undermines #290's read-only reconcile-candidate surface — the whole point of #290 is to SEE a reconcile candidate without acting on it, but `forge show` reconciles it out from under you on inspection.

**Acceptance:**
- `forge show` does not mutate by default (no `reconcileRun`, no `task.reconciled`/`run.reconciled` events on the read path).
- If the target is a reconcile candidate, `forge show` SURFACES that clearly with the reason (`container_gone_result_present` / `container_gone_no_result`) — reuse the #290 read-only classifier (`findReconcileCandidates` / `src/ops/reconcile-candidate.ts`) rather than mutating to discover it.
- Provide an explicit mutating path: `forge show --reconcile <id>` or a dedicated `forge reconcile <id>`.
- Existing lifecycle commands that intentionally reconcile (`forge next`, `forge status`, `forge gate`) remain explicit and documented as the mutating path — this ticket narrows `show` specifically, it does not remove reconciliation from the lifecycle.
- Tests prove plain `forge show` emits no `task.reconciled` / `run.reconciled` events (the Pixtron `task-engineer-b26b0f` shape — running + container gone + valid result.json — is the regression fixture).

**Notes / design pointers:**
- The reconcile call site is `src/cli/commands/show.ts` (reads the run, calls `reconcileRun` before rendering). `reconcileRun` lives in `src/v2/reconcile.ts`; the read-only classifier is `src/ops/reconcile-candidate.ts` (#290).
- Decide whether `forge status` should also be read-only-by-default (it currently reconciles its workspace-filtered runs). Out of scope here unless trivial — `show` is the reported incident; note it for a possible follow-up.
- This is the read/write-separation companion to #290 (surface candidates) and #295 (a read command mutated the DB).

Relations: #290, #295, #250, `src/cli/commands/show.ts`, `src/v2/reconcile.ts`, `src/ops/reconcile-candidate.ts`.