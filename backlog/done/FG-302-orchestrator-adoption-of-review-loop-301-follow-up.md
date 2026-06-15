---
id: FG-302
type: story
status: done
title: Orchestrator adoption of review-loop (#301 follow-up)
---

**Closed:** 2026-06-06.

Update orchestrator guidance so Forge-on-Forge work uses the bounded review-loop (#301) instead of manual reviewer/fixer relay.

**Scope:** (1) seeds/orchestrator-template.md source; (2) re-render this repo's live CLAUDE.md block; (3) regression guard over BOTH template + rendered live block.

**Behavior to encode:**
- Orchestrator owns route resolution + the initial implementation. review-loop is POST-IMPLEMENTATION only.
- After the initial implementation commit/range lands: `forge review-loop <ticket-id> --max-rounds 2 --route <resolved-route>` instead of manually relaying reviewer/fixer cycles.
- Present before starting the loop: ticket id, route key, commit range or --since, max rounds, reviewer/fixer roles, stop conditions.
- Do NOT use review-loop for initial implementation; do NOT manually relay reviewer/fixer when review-loop is available.
- Stop + ask the user on: blocked, max rounds reached, live spend, credential requirement, live DB migration, destructive op, product/acceptance ambiguity.
- Close a ticket only when review-loop reports closeable AND deterministic verification is green.
- If review-loop is unavailable or fails structurally, fall back to presenting the manual review result to the user.

**Acceptance:**
- Template contains the review-loop adoption rule.
- Live CLAUDE.md contains the same operational rule.
- Guard fails if either drops the rule or allows manual reviewer/fixer relay as the default.
- No model-policy integration, no multi-provider work.

Relations: #301, #287, #297, seeds/orchestrator-template.md.