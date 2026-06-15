---
id: FG-134
type: story
status: done
title: "Gate UX: don't suggest `forge next` when run is complete"
---

**Closed:** 2026-05-14. Commit `4b67e8a`.

**Why:** After gating the terminal step (`verify` in the feature workflow), `forge gate <taskId> advance` still prints `Next: forge next <run-id>` — but the runner already flipped the run to `complete` in `finalizeRunIfDone()`. The follow-up `forge next` would just print "nothing ready to dispatch."

**The fix:** in `src/cli/commands/gate.ts`, after the gate decision, check `getRun(task.runId).status` — if `complete`, print "Run complete." instead of "Next: forge next ...". Trivial (~5 lines).

**Caught:** 2026-05-14 — during forge v2 smoke test post-merge.