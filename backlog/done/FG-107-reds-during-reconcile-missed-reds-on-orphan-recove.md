---
id: FG-107
type: story
status: done
title: "Reds-during-reconcile: missed-reds-on-orphan-recovery is a design question"
---

**Closed:** 2026-05-26. Stale alongside #74 — reconcile was deleted in the v2 cutover (commit 5ad0061), so the design question this ticket frames no longer has a target code path. Re-file if v2 ever grows an orphan-recovery mechanism.

**Why:** Split from #91 (item 3) on 2026-05-12. When forge recovers an orphan task whose phase has reds attached, the reds may never have been spawned — the parent forge died before kicking them off. Reconcile today (post-#91) just transitions the task per its gate type and continues, silently skipping the reds. For **specialist reds** (gateOnVerdict: false, informational only) that's mostly fine — the audit is lossy but the workflow continues correctly. For **authoritative reds** (gateOnVerdict: true) that's a real correctness gap: reds were supposed to gate the advance, but their absence is invisible to the human.

**The two real options, both with tradeoffs:**

1. **Spawn missed reds during reconcile.** Reconcile detects the gap (phase declares reds, no red tasks exist for this parent) and dispatches them as part of the recovery. Pros: workflow behaves as if forge had never died. Cons: reconcile becomes a dispatcher, not just a state-fixer — bigger surface, more failure modes. Also: the original task's container is gone, so the reds run against the post-hoc artifact rather than the live agent. That's actually fine for most red types (they read result.json), but a category to verify.

2. **Force a human-visible audit gap.** Reconcile transitions the recovered task to `awaiting_gate` (regardless of the phase's actual gate type) and leaves a marker on the task that "reds did not run on recovery — review the diff manually." The human force-advances after eyeballing. Pros: simpler reconcile; the audit gap is surfaced rather than hidden. Cons: harder for the human (no red verdicts to lean on); workflow stalls on every recovery even for benign cases.

**Open design questions to resolve before implementation:**
- Does the answer differ for specialist vs authoritative reds? Probably yes — specialist can be silently skipped (option 2-lite: continue but log), authoritative MUST surface (option 1 or 2).
- How does reconcile detect "reds were declared but not spawned"? Needs to compare `phase.reds` config to the actual red tasks in the DB — a small new query, doable.
- Where does the audit marker live in option 2? A field on the task row? A separate notes table? The dashboard's task detail would need to render it.

**Caught:** 2026-05-12 — separated from #91 so the simpler gate-honoring fix can ship without waiting on this conversation.