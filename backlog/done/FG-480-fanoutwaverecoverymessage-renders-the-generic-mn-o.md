---
id: FG-480
type: story
status: done
title: fanoutWaveRecoveryMessage renders the generic M/N-orphaned wording for an all-children-complete (fanout_wave_unfinalized) parent — add the distinct unfinalized headline + a total===complete test
created: 2026-07-07
closed: 2026-07-07
---

FG-479 review-loop pass-level observation (non-blocking, cosmetic/fail-safe only).

The FG-479 fanout extension gives the all-children-complete orphaned parent a distinct task.error ("fanout parent unfinalized: all N children completed, but the parent's own merge/integration-gate/reds sequence never ran...") and reconcile reason (fanout_wave_unfinalized). But the friendly rendering helper fanoutWaveRecoveryMessage() in src/cli/commands/show.ts still renders the same generic "fanout wave orphaned — X/Y children completed..." text for both shapes, so the "recovery:" line reads as if children failed when every one succeeded (the accurate cause IS visible on the adjacent error: line, hence non-blocking).

AC:
- [ ] fanoutWaveRecoveryMessage distinguishes total===complete (unfinalized headline: wave finished, parent finalize never ran, re-drive) from the partial-wave wording.
- [ ] Test exercising fanoutWaveRecoveryMessage with total===complete asserts the distinct headline and that it does not claim children failed/never finished.
