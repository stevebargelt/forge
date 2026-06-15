---
id: FG-278
type: story
status: done
title: "RACI policy Story 5: add forge route validate (operational-policy lint)"
---

**Closed:** 2026-06-04.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Add `forge route validate` — validates the DERIVED policy as an executable policy in an environment. Runs at compile/deploy/resolve time and needs the host. Complements the host-independent `forge raci validate` (Story 4).

Acceptance:
- Reports schema errors against the Story 2 schema.
- Resolves against THIS host: the agent/workflow/CLI-action symbols raci validate shape-checked actually exist (responsible/consulted point at installed agents, known workflows, real CLI commands). Evidence-source consulted values (e.g. `affected_code`, `existing_tests`) resolve against the fixed evidence-source set, NOT host install state.
- (Project-override force-rule protection is NOT in this slice — route validate here takes one policy + optional RACI source, with no override input. That check is delivered with project override support, #280.)
- Drift check: when a RACI source is present, the policy still agrees with it.
- Runs STANDALONE where no RACI exists (e.g. a provider host shipped only the compiled policy — the #253 adapter case).
- Supports JSON output for orchestrator/provider-adapter use.
- Tests cover clean policy, schema-invalid, unresolved host name, override force-rule weakening, RACI/policy drift, and standalone (no-RACI) cases.

Relations: #273, #253.