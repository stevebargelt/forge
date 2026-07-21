---
id: FG-599
type: story
status: active
title: Durably record normal-delivery and replay-recovery so Q2 delivery-mode is answerable as a positive record (finding against FG-562/FG-563)
created: 2026-07-21
---

## Origin

Surfaced by the FG-565 (Slice 6 closeout) review-loop as a finding against the owning continuation-storage slices (FG-562 continuation claim / FG-563 orchestrator adoption + `continuation_lost_signal_recoveries`). FG-565 verifies the operator-visible-evidence questions; it does not implement new continuation storage (its no-new-features fence), so this is deferred here per the ticket's "finding against the owning slice" model.

## Finding

`forge lost-signals` durably records ONLY watchdog recoveries (`continuation_lost_signal_recoveries`; `src/store/continuation-lost-signal.ts:90` "never called on the normal delivery path"). Therefore the PRD closeout Q2 ("Was the completion observation delivered normally, or recovered by watchdog/replay?") is only partially answerable from durable evidence:

- **Recovered-by-watchdog** — durably recorded (a row). ✅
- **Delivered-normally** — inferred from the ABSENCE of a recovery row, not recorded per launch.
- **Recovered-by-replay** (`forge continue --recover` restart replay) — NOT recorded at all. `continuation-lost-signal.ts:33` notes replay is a "future recovery source ... can be added." The adopt path sets `lostSignalRecovered:false` (`consumer-core.ts`), so replay recovery leaves no audit row.

FG-565 corrected the docs/policy overclaim to describe this accurately (recovery ledger, not a delivery ledger) — `seeds/orchestrator-template.md`, `CLAUDE.md` marker block (`3a30546`), `docs/concepts.md`, `docs/quick-start.md`. This ticket owns making the underlying evidence a positive durable record.

## Scope

- Record a durable, per-launch delivery-mode fact so "delivered normally" is a positive record, not only the absence of a recovery row.
- Record restart-replay recovery as its own `recovery_trigger` value (the schema comment already anticipates it), so `forge lost-signals` / `forge continuation` can render replay-recovered completions.
- Extend the operator surfaces (`forge lost-signals`, `forge continuation`) to render the new delivery-mode / replay evidence.

## Acceptance criteria

- Normal delivery and replay recovery each produce a durable, queryable record (not inferred by absence).
- `forge lost-signals` (or `forge continuation`) renders delivery-mode and replay-recovery from durable state alone.
- A test observes each new record RED against the current no-record baseline before it goes green.
- The FG-565 docs/policy wording (recovery-ledger framing) is updated to the positive-record reality once shipped.