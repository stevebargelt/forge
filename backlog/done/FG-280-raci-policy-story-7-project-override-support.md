---
id: FG-280
type: story
status: done
title: "RACI policy Story 7: project override support"
---

**Closed:** 2026-06-05.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Support project-specific RACI/policy files under `<project>/.forge/`. A concrete near-term need: Forge already orchestrates real work across a portfolio, and different projects plausibly want different routing.

Acceptance:
- Project RACI override path (`<project>/.forge/forge-raci.md`) is real and wired into the prompt path, not merely documented (it currently is NOT — see PRD Problem).
- Project generated policy path (`<project>/.forge/routing-policy.yml`) is real.
- Validation makes clear whether project policy is full replacement or merge. Initial: full replacement.
- Project overrides may add/specialize routes but may NOT weaken force-level rules (validator-enforced).
- Tests cover host default, project override, invalid project override, and force-level weakening refusal.

Relations: #273, #252, #253.