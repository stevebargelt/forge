---
id: FG-270
type: story
status: active
title: "Reds: render the ## Spec section (architect intent + tech-lead plan) for cross-checking"
---

**Follow-up from #269.** The red seeds reference a `## Spec` section — "compare against the architect's intent + the tech-lead's plan (both in `## Spec`)" — but `renderTaskPackage` never produces it. Reds still function (they audit the artifact + read /project read-only), so this is degraded context, not a hard failure (#269 fixed the hard failures: artifact + failureModes + fanout dispatch).

**Scope:** thread the upstream architect result + tech-lead plan into the red task package (dispatchReds has the run's tasks available) and render a `## Spec` section. Gives reds the intent to grade against, not just the diff. Small, isolated.