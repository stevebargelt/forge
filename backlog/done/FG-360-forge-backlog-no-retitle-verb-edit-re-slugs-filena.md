---
id: FG-360
type: story
status: done
title: "forge backlog: no retitle verb + edit re-slugs filename on title change → duplicate same-id files"
created: 2026-06-22
closed: 2026-07-06
closed_commit: fa83eb32b836c6f90b9dbd88707da35b862037fe
---

**Found:** 2026-06-22 while re-scoping FG-345.

## Problem

Two coupled defects in the backlog CLI:

1. **No retitle verb.** `forge backlog edit` preserves the heading/title; there is no `forge backlog retitle <id> "<new title>"`. Changing a ticket's title requires hand-editing the frontmatter `title:` field directly — which the "use the CLI, don't edit files" guidance otherwise discourages.
2. **edit re-slugs the filename from the title and orphans the old file.** After the frontmatter `title:` was hand-edited, the next `forge backlog edit <id> --body -` computed a NEW filename slug from the changed title and wrote a SECOND file, leaving the original in place. Result: two files with the same `id:` (FG-345), and `forge backlog list` showed the ticket twice. Had to `git rm` the stale slug by hand.

**Why it matters:** two files with the same sticky id is a data-integrity bug — `show`/`edit`/`close` could act on either, and `list` double-counts. The reslug-on-edit behavior is surprising: a body-only edit should never move the file.

## Goal

Make ticket titles safely changeable via the CLI and guarantee one file per sticky id: a body-only edit never moves the file, and a title change (if supported) renames atomically with no orphan. Eliminate the possibility of two files sharing one `id:`.

## Acceptance Criteria

- A body-only `forge backlog edit <id>` NEVER renames/moves the ticket file (the slug is fixed at creation; the mutable title lives only in frontmatter/heading).
- Either: `forge backlog retitle <id> "<new>"` exists and updates frontmatter `title:` + the H1/H3 heading + (if the slug tracks the title) renames the file atomically — single file, no orphan; OR the slug is decoupled from the title entirely so retitle is a pure frontmatter/heading edit.
- A guard refuses to create a second file when one with that `id:` already exists (filing and editing both).
- `forge backlog list` never double-counts a ticket; `git ls-files backlog/` shows exactly one file per id.

## Fix options

- Add `forge backlog retitle <id> "<new>"` that updates frontmatter `title:`, the H1/H3 heading, AND renames the file slug atomically (single file, no orphan).
- Make `forge backlog edit` NEVER rename the file (slug is fixed at creation; title lives only in frontmatter/heading). The filename slug is cosmetic — it should not track the mutable title.
- Add a guard: filing/editing refuses to create a second file when one with that `id:` already exists.

## Scope

Small, isolated to the backlog CLI (`src/backlog/` + `src/cli/commands/backlog`). No schema change.
