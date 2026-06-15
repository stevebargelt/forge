---
id: FG-276
type: story
status: done
title: "RACI policy Story 3: compile RACI to routing policy"
---

**Closed:** 2026-06-04.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Add a compiler that reads the constrained RACI (Story 1 format) and emits `routing-policy.yml`.

Acceptance:
- Compiler parses the Story 1 constrained format deterministically; no dependence on loose prose.
- Generated policy validates against the Story 2 schema.
- Direction is strictly RACI -> policy; the compiler never writes back to the RACI.
- Tests cover representative rows: implementation full, implementation quick, documentation durable, review, ui-design/manual, ops repair, and orientation.

Relations: #273.