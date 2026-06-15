---
id: FG-269
type: story
status: done
title: Reds not fed the artifact; authoritative build (fanout) reds never dispatch
---

**Closed:** 2026-06-04. Commit `435a9e6`.

**Reported from a forge-site run.** The build phase's adversarial review silently did not run; a force-advance could ship an unreviewed diff.

**Three root causes in the v2 red-feed path (v1 src/spine deleted in #116; incompletely ported):**
1. **Fanout reds never dispatch (Symptom B):** `dispatchFanoutStep` aggregated children then jumped straight to `finalizePrimary` — it omitted the reds block that `dispatchSingleStep` has. So the build parent went to awaiting_gate with zero red task rows; the verdict gate had no verdicts to resolve.
2. **Artifact dropped (Symptom A / red-wide):** `renderTaskPackage` rendered only `## Inputs`; it never rendered `tp.artifact`. The red seeds read the artifact from a `## Artifact under review` section, so reds saw empty inputs and reported "no artifact provided."
3. **failureModes missing (Symptom A / red-narrow):** `runOneRed` set `inputs: {}`; force-level anti-prompts (which red-narrow requires as a `failureModes` input) were never populated. `compose.ts` left this "out of scope" and nothing else did it.

**Fix:** wire per-parent reds dispatch into the fanout path (mirror dispatchSingleStep); render `## Artifact under review` from `tp.artifact`; populate `inputs.failureModes` from force-level antiPrompts scoped to the reviewed (blue) role/workflow/phase. 4 regression tests added.

**Follow-up (separate):** reds also reference a `## Spec` section (architect intent + tech-lead plan) that the renderer doesn't produce — degraded context, not a hard failure. Filed separately.