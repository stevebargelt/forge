---
id: FG-312
type: story
status: done
title: Restructure BACKLOG.md into separate files — epics, stories, ideas
closed: 2026-06-15
---

**Goal:** Split the monolithic BACKLOG.md (~170KB, growing) into separate files organized by type (ideas, epics, stories, done) with project-prefixed IDs.

**Proposed structure:**
```
backlog/
├── ideas/           # Unrefined thoughts, not yet epics
│   ├── FG-001-foo.md
│   └── FG-002-bar.md
├── epics/           # Multi-story initiatives
│   ├── FG-258-provider-agnostic.md
│   ├── FG-273-raci-routing.md
│   └── FG-291-stable-baseline.md
├── stories/         # Concrete work units
│   ├── FG-130-bedrock-starvation.md
│   ├── FG-228-error-classification.md
│   └── FG-311-ops-reconcile.md
├── done/            # Recently completed
│   ├── FG-301-review-loop.md
│   └── FG-307-sessionend-hook.md
└── index.md         # Backlog view (generated or hand-curated)
```

**ID format:** Each project gets a 2-3 letter prefix (FG for forge). Existing sticky numbers are preserved but gain the prefix — `#130` becomes `FG-130`, `#312` becomes `FG-312`. References in commit messages work either way (`fixes #130` or `fixes FG-130`).

**Benefits:**
- Scales past 170KB
- Epics naturally group their stories
- Ideas have a landing zone before promotion to epic/story
- Git diffs are per-ticket, not one mega-file
- The `##` parser issue (#174) goes away
- Multi-project forge installs can distinguish FG-130 from PX-130

**Open questions:**
- Migrate existing tickets all at once, or incrementally?
- Does `forge backlog` CLI need to understand the new layout first?
- Frontmatter schema: `id`, `type` (idea/epic/story), `status`, `related`?

**Upgrade path constraint:** Must have a smooth migration for existing projects using forge. The `forge backlog` CLI should support BOTH formats during transition:
- **Read path**: detect whether `BACKLOG.md` exists (old format) or `backlog/index.md` exists (new format) and route accordingly
- **Write path**: `forge backlog file/close/move` work seamlessly regardless of format
- **Migration command**: `forge backlog migrate` converts existing BACKLOG.md → `backlog/` structure, preserving all ticket numbers and metadata
- **Backward compat**: old `#NNN` references in commits/docs continue to resolve after migration (the prefix is additive, not breaking)

This allows projects to upgrade forge itself without being forced to migrate their backlog immediately — migration happens when the project owner chooses to run `forge backlog migrate`.

**Related:** #174 (backlog edit-body verb + `##` parser issue).