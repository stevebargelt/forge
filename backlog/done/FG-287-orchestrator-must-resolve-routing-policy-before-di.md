---
id: FG-287
type: story
status: done
title: Orchestrator must resolve routing policy before dispatch
---

**Closed:** 2026-06-05.

**Epic:** #273. **Caught:** 2026-06-05 during first real-project routing test on Pixtron.

The RACI/routing substrate works, but the active orchestrator can still bypass it by habit: in the Pixtron test, the orchestrator initially jumped straight to `forge invoke engineer` from memory instead of resolving the work type through `forge route explain` first. That is a consumption/adherence bug, not a schema/compiler/dashboard bug.

Why this matters: #284 proved that the template can consume `routing-policy.yml`, but a real run showed that prose discipline is still skippable. If the orchestrator can dispatch from memory, project overrides and future routing-policy changes may not affect actual work even though the governance dashboard and `route explain` are correct.

Near-term scope:
- Strengthen the orchestrator template so every `forge invoke` / `forge run` decision is preceded by `forge route explain <work-type> --json` for the classified work type.
- Require the orchestrator to summarize the resolved route before dispatch: route key, path, responsible, required followups, and source (`host` or `project`).
- Explicitly mark direct shortcuts like `forge invoke engineer` invalid unless the route was just resolved from the compiled policy.
- Add a template/check test that the orchestrator block contains the routing-before-dispatch rule.

Longer-term follow-up to consider:
- Add a CLI affordance that makes the policy lookup and dispatch one path, e.g. `forge route invoke <work-type> ...` or `forge invoke --route <work-type> ...`, so the orchestrator is not asked to remember two separate commands forever.
- If feasible, make raw role dispatch warn or fail when called from an orchestrator context without a recent route resolution.

Acceptance:
- A fresh orchestrator prompt path tells the orchestrator to resolve the route immediately before dispatch.
- The resolved route is visible in the conversation before the task starts.
- Project override tests/dogfood can prove a changed project route affects the actual selected responsible/path, not only `forge route explain`.
- The direct-memory-dispatch failure seen in Pixtron is called out in the test or fixture as the regression case.
- No change to RACI schema or compiler semantics.

Relations: #273, #280, #284, #285, `seeds/orchestrator-template.md`.