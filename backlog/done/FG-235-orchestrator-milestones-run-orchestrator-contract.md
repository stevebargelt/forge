---
id: FG-235
type: story
status: done
title: "Orchestrator milestones — Run: orchestrator-contract to emit milestones only at checkpoint boundaries"
---

**Closed:** 2026-06-01. Commit `b138af1`.

Final slice of #202/#203 (Crawl shipped e168fcc; Walk = per-run policy). This is a SEED/prompt contract, not enforceable code: teach the forge-orchestrator CLAUDE.md block to emit `forge notify milestone` at natural checkpoints and NEVER on ordinary conversational replies.

Checkpoints (from the design):
- "finished implementing the slice and tests pass" -> batch_complete / acceptance_green
- "finished reviewing the agent's changes; findings ready" -> ready_for_review
- "need your decision before continuing" -> decision_needed
- "long-running workflow complete" -> batch_complete (forge gates on elapsed)
- "found a security/correctness issue worth interrupting for" -> risk_found / blocked
- "shipped" -> shipped

Add to the orchestrator block: emit at checkpoint boundaries only; use a stable --dedupe-key per logical checkpoint; let forge's policy/dedupe handle throttling (don't self-censor — emit the milestone, forge decides delivery). Forge remains the backstop (policy/dedupe/audit) regardless of orchestrator discipline. Update CONTRIBUTING/orchestrator-template seed so all projects get it via forge init/upgrade.

Note: supersedes the interim "curl $NTFY_URL for blocker/decision/batch-landed" guidance (memory feedback_ntfy_when_needed) — the milestone command is the proper mechanism.