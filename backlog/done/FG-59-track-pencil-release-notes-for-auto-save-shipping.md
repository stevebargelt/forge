---
id: FG-59
type: story
status: done
title: Track Pencil release notes for auto-save shipping
---

**Closed:** 2026-05-25. Not work, just a watch reminder — closing as such. Re-file as actionable when Pencil ships auto-save (or any 0.3+ release that affects the PROMPT.md template's Cmd+S/stat-verification scaffolding).

**Why:** Pencil 0.2.5 has no auto-save (https://docs.pencil.dev/troubleshooting). Our PROMPT.md template has a load-bearing "Cmd+S to save dashboard.pen" warning + a stat-verification step. When Pencil ships auto-save, the warning becomes obsolete.
**How to apply:** Periodically run `npm view @pencil.dev/cli version` and check the changelog. When auto-save lands:
- Update the prompt-author template to drop the loud Cmd+S warning + the stat-verification step.
- Test that the .pen file persists without human Cmd+S in a real run.
- Update FORGE-DEC-014 with a "Revisited" note pointing at the simpler flow.
Lightweight: probably one check every couple of months unless we hear about it sooner.