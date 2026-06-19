---
id: FG-283
type: story
status: done
title: "RACI policy Story 10: provider adapter generation (#253 seam)"
closed: 2026-06-19
---

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

After the routing policy is stable, use it as input to provider adapter GENERATION per #253 — rendering adapter surfaces FROM the policy. Distinct from #284 (Story 5b), which proves ONE surface consumes the policy by hand; this is the full generated-adapter lift. Downstream consumer; does NOT block the routing-policy MVP.

Acceptance:
- Define how Claude Code adapter surfaces (`CLAUDE.md`, `.claude/commands/*`, hooks) RENDER from routing policy.
- Define equivalent or fallback behavior for Codex / generic adapters (these may have only the compiled policy, no RACI — see Story 5 standalone validation).
- Adapter generation fails or warns when the routing policy is invalid.
- Shared behavior lives in provider-neutral primitives/policy, not duplicated per adapter.

Relations: #253, #273, #252, #284, `seeds/orchestrator-template.md`.