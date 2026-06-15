---
id: FG-143
type: story
status: done
title: "Dashboard: per-project label + color on every task card"
---

**Closed:** 2026-05-25. Commit `e84dc63`.

Filed 2026-05-25. As multi-project use grows (post-#138 workspace scoping + #140 dashboard re-merge), the dashboard's cross-project survey surface needs visual project labeling. Today there's none — task cards/rows from different projects look identical, and it gets confusing fast.

**Why filed.** Lived experience: running several projects through forge produces a homogeneous activity feed that doesn't say which project each task belongs to. The data is already populated (queries.ts puts `projectDir` on every ActivityEntry + InFlightEntry); the client just doesn't render it.

**Fix shape (shape 2 from the design conversation — label + color).**

1. **Label.** Show basename of `projectDir` on every card/row (e.g. `forge`, `my-app`). Full `projectDir` shown on hover via title attribute. Empty/null projectDir gets `—` or `(no project)`.

2. **Color.** Each project gets a consistent visual identity:
   - **Preferred source:** read `<projectDir>/.vscode/settings.json` and extract `workbench.colorCustomizations["titleBar.activeBackground"]`. Matches the color the user already assigns to that project's VS Code window for the same purpose (window identification). Reusing the editor color means zero new mental load.
   - **Fallback:** if no .vscode color (file missing, key absent, JSON malformed, or projectDir doesn't exist on disk), hash projectDir → HSL hue with fixed saturation/lightness tuned for legibility against the dashboard's dark background.
   - Cache per projectDir to avoid re-reading on every request.

3. **Where rendered.** Activity feed cards (small badge at top-left of each card). In-flight strip (color stripe on the side, or chip in the corner). Task detail view (header chip with the project name + color).

**Out of scope here.**
- Project filter UI (chip row / dropdown to filter "show only this project"). Worth doing later if label+color alone isn't enough.
- User-overridable project colors (e.g. dashboard-side color config). The .vscode source + hash fallback covers the natural case.
- Reading any other .vscode value (e.g. titleBar.activeForeground for contrast). Just the background for now; the dashboard chooses its own text color for legibility.

**Implementation surface.** Probably ~80 LoC total: a small project-meta helper in `dashboard/src/queries.ts` (or a sibling file) that resolves project metadata (basename + color) with caching, the API response includes it per entry, and `dashboard/client/renderers.js` renders the chip. Tests: file present, file missing, malformed JSON, key absent — verify the color resolution falls back cleanly in each case.

**Caught:** 2026-05-25 in conversation — observation that the feed gets confusing across multiple projects.