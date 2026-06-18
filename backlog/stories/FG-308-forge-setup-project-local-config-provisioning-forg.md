---
id: FG-308
type: story
status: active
title: "forge setup: project-local config provisioning (.forge/model-policy.yml + docs-surfaces.yml) + forge new first-run advisory"
---

**Type:** Follow-up / enhancement from #252's review-loop. The #252 review-loop fixer attempted this autonomously but it landed through a structurally-failed loop (reviewer_failed; round-2 verification broke), so the unreviewed WIP was discarded. Re-do cleanly.

#252 shipped HOST-level readiness: `forge setup` guided-creates `~/.forge/model-policy.yml` from seed, ensures routing-policy, runs the release check + Codex review-loop readiness.

**Scope (host-level only — project-local setup moved to FG-332):**
- Extend the release/doctor report with host-surface readiness (routing-policy, model-policy, workflow-specific config) — pure-function + injected-deps tested.
- `forge new`: a non-blocking first-run advisory when project-local config is missing, pointing at `forge init`.
- Run it through the review-loop to a clean pass (or acceptance-met close), not a failed-loop landing.
- Install a `docs-surfaces.example.yml` seed via install-seeds (parallel to model-policy.example.yml).

Relations: #252 (host-level shipped), #246 (docs-surfaces project config pattern), #229 (release-doctor surfaces), #332 (project-local init — split out from this ticket).