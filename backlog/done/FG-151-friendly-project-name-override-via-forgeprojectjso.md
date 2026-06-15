---
id: FG-151
type: story
status: done
title: Friendly project name override via .forge/project.json
---

**Closed:** 2026-05-26. Commit `d8e8199265b44ab85c13a56d0b0c661a8143db42`.

Filed 2026-05-26. Smallest piece of the project-registry / orchestrator-tracking arc; ships first since both later features (forge projects CLI, dashboard Projects view) consume it.

**Problem.** Project labels in the dashboard chip + future registry derive from basename(projectDir). Some projects' directory names aren't friendly ("pocket-v1" → "Pocket — typing tutor"). User needs a way to override.

**Shape.** Optional file at \`<projectDir>/.forge/project.json\`:

\`\`\`json
{
  "name": "Pocket — typing tutor",
  "description": "split-keyboard pen-down trainer"
}
\`\`\`

Both fields optional. Missing file OR missing field → fall back to basename behavior (current).

Lives in \`.forge/\` (already created by \`forge init\`). No new directory.

**Why JSON over YAML.** Dashboard already parses JSON for .vscode color; no new parser needed. The shape is trivially flat; YAML's structural advantages don't apply.

**Why not piggyback on .vscode/settings.json** (where we get the color from): VS Code-specific. Some users / machines won't have VS Code. \`.forge/project.json\` is forge-native and works regardless.

**Implementation surface (small, ~30 LoC):**
- \`dashboard/src/project-meta.ts\` — extend the existing resolver. Read \`<projectDir>/.forge/project.json\` after the .vscode lookup. Return \`{label, color, description?}\`. \`label\` becomes \`name\` if present, basename otherwise.
- Dashboard \`ProjectChip\` already uses the resolved \`label\` — picks up the override automatically.
- Existing project-meta.test.ts adds 3-4 tests: project.json present with name only, with name + description, missing file (basename fallback), malformed JSON (basename fallback).

**Out of scope this ticket:**
- CLI to set the name (\`forge projects set\`). For now, edit the file by hand — fine for personal use.
- Reading project.json from anywhere outside the dashboard. The future forge projects list CLI will need it too; at that point refactor into a shared module. Don't preemptively move code.
- Caching invalidation when project.json changes mid-process — restart dashboard to pick up.
- Description anywhere — it's read but only stored on the entry; rendering it is for the future Projects view ticket.

**Composite with:**
- #(future) forge projects list — registry CLI. Reads the same resolver.
- #(future) orchestrator heartbeats — \`~/.forge/orchestrators/\` driven by Claude Code SessionStart/Stop hooks.
- #(future) dashboard Projects view — composes registry + heartbeats + friendly names.

These three are listed in the 2026-05-26 conversation; will file separately.

**Sizing.** Tiny. One focused session.

**Caught:** 2026-05-26 design conversation about project-registry / orchestrator-visibility feature arc.