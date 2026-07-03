---
id: FG-446
type: story
status: active
title: "forge setup/init: interactively prompt for the backlog ticket-id prefix (FG-332 added --prefix flag but setup never asks, so projects silently default to FG)"
created: 2026-07-03
---

## Problem

The backlog ticket-id prefix lives in `.forge/config.yml` under `backlog.prefix` (src/backlog/config.ts:7), defaulting to `null` → falls back to `FG`. FG-332 added a `forge init --prefix <PREFIX>` flag, but it is a non-interactive flag: if the operator does not pass `--prefix`, the project silently inherits `FG`. So running setup without knowing the flag exists produces the wrong (default forge-repo) prefix.

Observed: two separate projects — constellation and trakt-letterboxd — both ended up using `FG` as their ticket prefix even after running forge setup, because nothing prompted for a project-specific prefix. This collides conceptually with forge's own `FG` tickets and is confusing across projects.

## Goal

Setup interactively prompts the operator to choose a backlog ticket-id prefix (with a sensible suggested default derived from the project name), and writes it to `.forge/config.yml`, so a project does not silently inherit `FG`. The existing `--prefix` flag remains as the non-interactive path.

## Acceptance Criteria

- `forge setup`/`forge init` (interactive path) prompts for a ticket-id prefix, showing a suggested default derived from the project (e.g. an uppercased short slug of the directory/repo name), and writes the chosen value to `.forge/config.yml` `backlog.prefix`.
- The existing `--prefix <PREFIX>` flag still works and skips the prompt (non-interactive / scripted path unchanged).
- A `--yes`/non-interactive invocation with no `--prefix` uses the suggested default (or an explicit documented fallback), not a silent `FG`, and reports the chosen prefix.
- Prefix is validated (e.g. non-empty, allowed characters) and the chosen value is echoed back so the operator can see what was set.

## Refs

- src/backlog/config.ts (backlog.prefix schema + read/write), src/cli/commands/init.ts (--prefix flag, FG-332)
- Complements FG-346 (interactive provider/model selection in setup) — same interactive-setup surface; and FG-447 (rename the prefix after the fact, for projects already stuck on FG).
