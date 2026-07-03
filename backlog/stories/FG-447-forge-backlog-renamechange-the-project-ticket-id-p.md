---
id: FG-447
type: story
status: active
title: "forge backlog: rename/change the project ticket-id prefix after the fact (update .forge config + re-slug existing ticket files) — no path exists once tickets are created"
created: 2026-07-03
---

## Problem

Once a project has created tickets under a prefix, there is no way to change that prefix. Editing `.forge/config.yml` `backlog.prefix` only affects NEWLY-created tickets; it does not rename existing `FG-NNN` ticket files, their frontmatter `id:`, or the `#NNN`/`FG-NNN` references in commits and notes. So a project that landed on the wrong prefix (see FG-446: constellation and trakt-letterboxd both stuck on `FG`) is stuck.

## Goal

An operator can rename a project's ticket-id prefix after tickets exist, via an evidence-safe command that updates the config AND re-slugs existing ticket files + frontmatter consistently, without leaving partial/duplicate state.

## Acceptance Criteria

- A `forge backlog` command (e.g. `forge backlog rename-prefix <OLD> <NEW>` or `--prefix <NEW>`) updates `.forge/config.yml` `backlog.prefix` to the new value.
- Every existing ticket under `backlog/**` is renamed from `<OLD>-NNN-*` to `<NEW>-NNN-*` (filename) with its frontmatter `id:` updated to match, preserving the numeric id (never renumber) — across stories/, done/, epics/, ideas/.
- The operation is atomic / all-or-nothing: it does not leave a mix of `<OLD>-` and `<NEW>-` files or duplicate same-id files (reuses the FG-397/FG-398 atomic move + id-safety discipline; cf. FG-360 re-slug duplicate hazard).
- Dry-run/preview mode shows what would change before writing; the command reports the count renamed.
- Out of scope (documented): rewriting historical `#NNN`/`<OLD>-NNN` references already baked into past commit messages — those stay as historical record.

## Refs

- src/backlog/config.ts (backlog.prefix), src/backlog/ (serialize/move/close atomic ops — FG-397/FG-398), FG-360 (retitle re-slug duplicate-id hazard — same re-slug risk class)
- Paired with FG-446 (prompt for the prefix at setup time so this is rarely needed going forward).
