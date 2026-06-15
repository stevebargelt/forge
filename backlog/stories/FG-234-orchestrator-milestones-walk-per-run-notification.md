---
id: FG-234
type: story
status: active
title: "Orchestrator milestones — Walk: per-run notification policy (quiet|normal|verbose) + --notify-policy"
---

Builds on the Crawl slice (forge notify milestone + orchestrator.milestone events + default per-kind policy + dedupe, shipped e168fcc, #202/#203).

Add a per-run notification policy stored in run metadata:
- quiet: only interrupt-worthy kinds (decision_needed, blocked, risk_found).
- normal (default): the Crawl per-kind policy as-is.
- verbose: also push the suppressed-by-default kinds (plan_started, batch_complete regardless of elapsed).
- `forge new <wf> --notify-policy <p>` and `forge invoke <agent> --notify-policy <p>` set it (stored like modelProfile/authProfile in run metadata; CONTROL_PLANE_METADATA_KEYS so it never leaks into prompts — see #227).
- emitMilestone reads the run's policy and adjusts decideMilestone (the policy table becomes policy-aware: quiet drops normal-importance always-kinds to suppressed; verbose promotes suppressed).

Out of scope: the orchestrator-contract (when to emit) — that's the Run slice.