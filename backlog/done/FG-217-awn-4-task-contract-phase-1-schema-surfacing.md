---
id: FG-217
type: story
status: done
title: "AWN-4 task-contract (PHASE 1: schema + surfacing)"
---

**Closed:** 2026-05-30. Commit `751cae7`. Phase-1 scope only ("schema + surfacing first"); the phase-2 acceptance below was moved to #223 — this item is NOT the full §4.

docs/agentic-workflow-next-steps.md §4. Sharper agent assignments + concrete review criteria.

Scope:
- Explicit task contract object in task packages: objective, allowed_paths, expected_artifacts, validation.commands, auth_profile, risk, review.{required,invariants}.
- Markdown-readable AND machine-readable (manifest/package metadata).
- Orchestrator template prefers contracts when invoking agents.

Example (from the doc):
  contract:
    objective: "Add cancel race tests"
    allowed_paths: [src/cli/commands/cancel.ts, src/v2/cancel.test.ts]
    expected_artifacts: [result.json, tests]
    validation: { commands: ["npm test -- src/v2/cancel.test.ts"] }
    auth_profile: null
    risk: medium
    review: { required: true, invariants: ["cancel remains idempotent", "reds never receive auth state"] }

Acceptance — PHASE 1 (met, this ticket):
- New tasks expose their contract in forge show. ✓
- forge invoke --contract carries it into manifest.contract + the agent's package.md (rendered, with a deviation instruction). ✓
- Strict Zod schema (YAML/JSON), typo-rejecting. ✓

Acceptance — PHASE 2 (NOT met here; moved to #223):
- Result manifests record which contract checks were satisfied.
- Agents' result schema includes contract_deviations; forge show flags it.
- >=1 WORKFLOW declares a contract (workflow-YAML integration; phase 1 is forge-invoke only).
- Orchestrator template prefers contracts when invoking agents.

Known phase-1 limitation: the contract lives in the manifest + rendered package.md, NOT in the persisted TaskPackage type (src/types/index.ts) — phase 2 can promote it if a persisted-package consumer needs it.

First of the agent-quality pair (AWN-4/5).