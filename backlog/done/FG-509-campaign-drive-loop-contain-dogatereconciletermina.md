---
id: FG-509
type: story
status: done
title: "campaign drive loop: contain doGate/reconcileTerminalOutcome throws — park item recoverably, campaign running to paused (audit N-A)"
created: 2026-07-10
closed: 2026-07-10
closed_commit: 9e3a920
---

Source: notes/forge-engineering-review-2026-07-09.md finding N-A (MEDIUM, verified) — the FG-490 dead-end re-opened on two edges. Top unattended-campaign blocker.

Evidence: executor.ts:618 (reconcileTerminalOutcome) and executor.ts:684,689 (doGate) are UNWRAPPED, vs the wrapped runNextFn at executor.ts:748-752. A gate() throw (illegal transition, DB error) unwinds through driveRemainingItems (unwrapped call sites executor.ts:1096, :1334) to the CLI; no park happens; the campaign is wedged at running and resume refuses (not_paused).

Fix shape (from the audit): wrap both call sites in the existing parkCampaignOnDriveThrow containment. Containment only — do NOT redesign gate semantics, do NOT touch parallel-lane behavior, do NOT reopen FG-502 reviewed-tip semantics.

Acceptance:
- [ ] a throw from doGate during campaign drive parks the item recoverably and transitions the campaign running to paused — no stranded running campaign, no unparked CLI unwind
- [ ] a throw from reconcileTerminalOutcome during campaign drive does the same
- [ ] campaign resume succeeds after such a park (no not_paused refusal) and can re-drive
- [ ] invariant tests exercise a throwing gateFn AND a throwing reconcileTerminalOutcome through the real drive path (not just throwing runNextFn/startRunFn) asserting item park + campaign paused
- [ ] test and test-extended green on the exact PR head; review-loop closeable before merge