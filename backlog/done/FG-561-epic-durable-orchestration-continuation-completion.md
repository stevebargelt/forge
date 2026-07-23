---
id: FG-561
type: epic
status: done
title: "[EPIC] Durable orchestration continuation — completion-driven phase advancement with a stable control runtime"
created: 2026-07-14
closed: 2026-07-23
closed_commit: b0dd651
---

## Epic closure (2026-07-23)

All eight slices are shipped and closed; the campaign closeout gate is satisfied. FG-553 (the last-blocking slice) closed on aggregate AC evidence today (F23–F35, F29 executed under a hostile PATH, F28/T9 settled empirically, F30 R1/R2 + explicit R3/R4 contract, F31 ABI refusal, BD-13/14/15). FG-565 — the designated closeout slice — verified the end-to-end F1–F35 + T9 fault matrix as one system and ran the focused PRD review, which is the epic's "final reviewer maps evidence to every binding decision and matrix row" gate.

| Closeout-gate item | Slice(s) | Status |
|--------------------|----------|--------|
| Agent test-environment parity without changing work ownership | FG-551 (`7f6091b`) | met |
| Machine-wide mutable-source coupling AND caller-env dependence eliminated; promotion/rollback/runtime-identity/store-compat proven | FG-553 (aggregate: FG-567–572) | met |
| Launched-workload boundary (R3/R4) | FG-555 | met |
| Atomic, authoritative exit record + `forge launch wait` covering every terminal disposition; subscribe race closed | FG-552 | met |
| Lost + duplicate notifications proven safe | FG-562 | met |
| Orchestrator + campaign runner share one primitive with durable idempotent continuation | FG-563, FG-564 | met |
| ScheduleWakeup is a lost-signal watchdog only; Monitor workaround retired or explicitly retained as a named fallback | FG-563, FG-565 (retained as named fallback) | met |
| Canonical seed, generated project block, docs, installed surfaces agree | FG-572 (+ FG-577–583) | met |
| Every falsification test observed RED against baseline before green | children's evidence throughout | met |
| Final reviewer maps evidence to every binding decision + matrix row (not green CI alone) | FG-565 closeout verification | met |

Durable orchestration continuation is complete: an ordinary workflow transition is completion-driven (launch reaches terminal → controller wakes → rereads durable truth → claims one transition → advances once), timers are watchdogs only, and the control plane runs a stable promoted runtime isolated from the work it supervises.
