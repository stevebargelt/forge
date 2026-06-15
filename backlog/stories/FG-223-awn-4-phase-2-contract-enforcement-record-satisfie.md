---
id: FG-223
type: story
status: active
title: "AWN-4 phase 2: contract enforcement — record satisfied checks, workflow-YAML contracts, orchestrator prefers contracts"
---

Follow-up to AWN-4 phase 1 (#217, which landed the TaskContract schema + manifest carry + forge show + forge invoke --contract). Phase 2 closes the doc's remaining §4 acceptance:

- Result manifest records which contract checks were satisfied: after a task with a contract completes, capture pass/fail per validation command + per expected_artifact (the agent runs validation and reports; or forge verifies artifact presence). Surface in forge show ("contract: 3/3 checks satisfied").
- Declare contracts in workflow YAML (per-step `contract:` block, loaded by loader.ts/schema.ts), so pipeline steps carry contracts, not just forge invoke.
- Orchestrator template prefers contracts when invoking agents (CLAUDE.md / forge-raci guidance: build a contract for implementation tasks).
- Agents instructed to report deviations explicitly — the renderContract note already tells them; phase 2 makes the result schema include a `contract_deviations` field and forge show flags it.

Builds directly on #217's TaskContract type + contract.ts.