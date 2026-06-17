---
id: FG-332
type: story
status: active
title: "forge init: scaffold backlog + project-local config (model-policy, docs-surfaces) — everything needed to start a new project"
created: 2026-06-17
---

forge init should be the single command anyone runs to set up forge in a new project folder. Currently it installs the CLAUDE.md orchestrator block, .forge/ dir, and git hooks — but stops short of everything needed.

**Add to forge init:**
- Scaffold backlog/ directory structure: stories/, epics/, ideas/, done/
- Create backlog/notes.md (empty)
- Prompt for (or accept --prefix flag) ticket prefix, write to .forge/config.yml
- Guided-create .forge/model-policy.yml from seed when absent
- Guided-create .forge/docs-surfaces.yml from seed when absent

**Acceptance criteria:**
- After forge init in a fresh directory, forge backlog file/list/notes all work without manual setup
- Never overwrites existing files (idempotent re-runs safe)
- --dry-run shows what would be created

Relations: FG-308 (host-level setup; project-local scope being moved here)