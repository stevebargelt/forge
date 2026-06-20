---
id: FG-42
type: story
status: done
title: Rewrite docs/how-to-new-workflow.md with a workflow we don't already have
closed: 2026-06-20
---

**Why:** Current example is `code-review` which duplicates the existing `codebase-assessment` workflow. The doc reads as a paper exercise. Replace with a workflow forge actually doesn't have, ideally one that exercises a primitive we've built but not documented (`onReject` branching, gate=verdict + fanout combo, multi-authority red panels).
**How to apply:** Brainstorm the right new workflow first. Candidates: a workflow that uses `onReject` (also closes #25 validation); a workflow with both authoritative and specialist reds across phases; a workflow that genuinely needs a new role (forces also exercising `how-to-new-agent.md`).