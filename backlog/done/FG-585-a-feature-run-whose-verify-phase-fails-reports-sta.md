---
id: FG-585
type: story
status: done
title: "a feature run whose verify phase FAILS reports status: complete while its gate:auto docs phase silently never runs — false completion"
created: 2026-07-17
closed: 2026-07-18
closed_commit: f0661fa9626a1fceddf3b30a673a197a624d57fe
---

> **Recovery disposition (operator, 2026-07-17):** KEEP ACTIVE — an orchestration-integrity defect, not
> optional hardening (false completion can skip required phases while reporting success). Do NOT start it now; ACs unchanged (not expanded) in this record pass.


**Observed live:** FG-577's feature run
`run-fg-577-install-path-resolves-release-owned-assets-from-the-executing-release-aa4226`, 2026-07-17.
**Related:** FG-477 (workflow run lifecycle evaluator) — this is a concrete instance of the drift FG-477 exists
to eliminate, and may be a slice of it rather than a standalone fix.

## What happened

`task-verify-407fe5` (verify phase) ended `failed` with `error = no_result_json`. `seeds/workflows/feature.yml`
declares `docs` with `depends_on: [verify]` (`:133-137`), so the docs phase became permanently undispatchable.

**The run then reported `status: complete`, and `forge next` printed "Run complete."**

A run is therefore reported COMPLETE while:
- a phase is `failed`, and
- a declared downstream phase (`docs`, `gate: auto`) never ran and never can.

## Why this matters

This is a **false completion**, and it is squarely in the wrong-ship class the campaign cares about:

- The docs phase is the pipeline's ONLY automatic docs-impact resolution. In this very run, `red-wide` had
  raised two authoritative MEDIUM findings that `docs/how-to-upgrade.md:16-18` and
  `docs/work-laptop-setup.md:33-34` now contradict shipped behavior, and the build fixer reported
  `docs_impact: operator_behavior_changed`. Both were correctly deferred TO the docs phase — which then
  silently never ran, while the run reported success.
- An orchestrator that trusts `run.status` — or an operator reading the dashboard — sees `complete` and has no
  signal that docs reconciliation was skipped. Only reading every phase's status catches it.
- It interacts badly with campaign advancement (FG-564's slice consumes run/item state) and with done-audit:
  a `complete` run is exactly what downstream consumers treat as the green light.

## Expected

A run whose terminal state leaves a `failed` phase AND undispatched downstream phases must NOT report
`complete`. It should report a state that names the truth — `failed`, or a distinct
incomplete/partially-complete state — and the operator surface must say which phase failed and which phases
never ran. Silence is the defect.

## Acceptance (EXECUTED)

- A feature-shaped run whose `verify` fails does NOT report `complete`; the run state names the failure and the
  undispatched downstream phases. Observed RED against current code (this exact scenario reproduces it).
- `--json`, human `forge show`/`forge status`, and the dashboard agree on that state — no consumer reads
  `complete`.
- Campaign/done-audit consumers do not treat it as a green light.
- Whatever state is chosen, a run with an unreachable `gate: auto` docs phase is distinguishable from one whose
  docs phase ran and passed.

## Notes
- Do not fix by making `docs` not depend on `verify` — the dependency is correct. The bug is the completion
  evaluator's reading of it.
- Check whether this is better implemented as an FG-477 slice than as a standalone change; FG-477 exists
  precisely so ready-queue, run completion, gate recovery, campaign resume, reconcile, and operator surfaces
  cannot disagree about this.