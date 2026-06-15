---
id: FG-152
type: story
status: done
title: "forge projects list CLI: registry derived from runs DB + filesystem scan"
---

**Closed:** 2026-05-26. Commit `e57e6e0c807c032eacd4dc22352460e04677a0cc`.

Filed 2026-05-26. Second piece of the project-registry / orchestrator-tracking arc; needs #151 (friendly name override) shipped to consume the project.json names.

**Problem.** User comes back from a break (travel, vacation) and can't easily remember every directory that is an active forge project, what state each is in, where on disk they live. No registry today.

**Shape — implicit registry, no new persistent state.** A "forge project" is detectable from existing signals:
- **DB:** \`SELECT DISTINCT project_dir FROM runs WHERE project_dir IS NOT NULL\` — every projectDir forge has ever dispatched against.
- **Filesystem:** scan a configurable root (default \`~/code\`, bounded depth) for directories whose \`CLAUDE.md\` contains the \`<!-- forge:orchestrator-start -->\` marker. Catches forge-init'd projects that haven't yet had a run.

Union, dedupe, sort by last activity. No \`forge projects add\` ceremony; \`forge init\` (or first \`forge new\` against a dir) effectively registers via these signals. Deleting a project drops it out naturally.

**Per-project metadata (no new tracking):**
- Friendly name (from \`.forge/project.json\` per #151) or basename
- Description (from \`.forge/project.json\`)
- Project color (from \`.vscode/settings.json\` titleBar.activeBackground — already resolved by dashboard/src/project-meta.ts)
- Last forge activity (max created_at across all runs/tasks for this projectDir)
- Total run count
- In-flight count (active runs + awaiting-gate runs)
- BACKLOG.md presence (\`<project>/BACKLOG.md\` exists?)
- README first line, if a README exists (the "what is this?" reminder)
- Last git commit timestamp (\`git log -1 --format=%ct\` cross-check, optional — guards against the case where forge.db says "active 6 months ago" but git shows "yesterday")

**CLI surfaces:**
\`\`\`
forge projects list                              # table sorted by last activity
forge projects list --sort=name                  # alphabetical
forge projects list --json                       # for scripting / dashboard
forge projects show <name>                       # detailed view of one project
forge projects show <name> --json                # detailed JSON
\`\`\`

Filesystem scan root configurable via env var (\`FORGE_PROJECT_SCAN_ROOTS=~/code,~/work\`) and \`--scan-root\` flag. Default \`~/code\` with max depth 3 (bounded to prevent runaway scans on large hierarchies).

**Implementation surface (~80-100 LoC):**
- New \`src/cli/commands/projects.ts\` — subcommand registration + handler logic.
- Refactor \`dashboard/src/project-meta.ts\` into a shared location (probably \`src/util/project-meta.ts\` with a re-export from the dashboard alias). Both CLI + dashboard read project.json + .vscode color from the same code.
- New SQL helper (in src/store/runs.ts or sibling): \`uniqueProjectDirs(): Array<{projectDir, lastRunAt, runCount, inFlightCount}>\`.
- Filesystem scan helper — pure-ish, recursive walk with depth bound, looks for CLAUDE.md + orchestrator marker.
- Tests for the SQL helper, the filesystem scanner, and the CLI command's pure formatting logic.

**Out of scope:**
- Dashboard Projects page (separate ticket — #154).
- Orchestrator-heartbeat integration (separate ticket — #153).
- \`forge projects add / remove\` (none needed — implicit registry).
- \`forge projects set <field> <value>\` to mutate project.json. For now, edit the file.

**Sizing.** Small-medium. One focused session.

**Caught:** 2026-05-26 design conversation.