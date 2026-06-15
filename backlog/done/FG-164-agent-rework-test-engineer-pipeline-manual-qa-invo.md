---
id: FG-164
type: story
status: done
title: "Agent rework: test-engineer (pipeline) + manual-QA (invoke-only) + engineer self-verification"
---

**Closed:** 2026-05-28.


**Problem:** The current qa-engineer agent is a rubber stamp — re-runs unit tests, maybe takes a screenshot, reports. Burns tokens without catching real bugs. Engineer seed has validation language but agents skip browser-tools in practice.

**Three roles with clear boundaries:**

**Engineer** (build phase — tighten existing seed):
- Builds feature per plan, writes and runs unit tests
- Self-verifies: browser-tools for web apps, explicit "no visual verification path" for mobile/CLI
- Project-type-aware: reads Stack section to know what verification is possible
- Never returns `status: complete` without validation evidence

**Test Engineer** (build phase — NEW, replaces qa-engineer in default pipeline):
- Writes integration and E2E tests that prove the feature works through real user flows
- Web apps: browser-based test flows. Non-web: integration tests exercising real component interactions
- Output is committed test files — durable regression coverage, not a one-shot report
- Does NOT re-run unit tests. Does NOT do exploratory clicking.

**Manual QA** (verify phase — NEW, invoke-only, NOT in default pipeline):
- Acts like a real user: opens the app, clicks through flows, tries edge cases (weird inputs, empty states, overflow, resize)
- Output is a verdict with evidence (screenshots, repro steps). No test files.
- Does NOT run unit tests. Ever.
- Orchestrator invokes when diff is UI-heavy/user-facing; skips for refactors, CLI, backend-only

**Scope:**
1. Create `test-engineer` seed (new agent dir + CLAUDE.md)
2. Rework `qa-engineer` → `manual-qa` (rename or create new + deprecate)
3. Tighten `engineer` seed: project-type-aware verification, sharper enforcement
4. Update `frontend-specialist` seed to match
5. Update orchestrator template: RACI table, role descriptions, pipeline slot
6. Update workflow definitions referencing qa-engineer by name
7. Update forge CLAUDE.md orchestrator block (role table, gate-decision discipline)