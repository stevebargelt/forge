---
id: FG-154
type: story
status: done
title: "Dashboard Projects view: registry + orchestrator status as one page"
---

**Closed:** 2026-05-26.

Filed 2026-05-26. Fourth piece of the project-registry / orchestrator-tracking arc; consumes #151, #152, #153.

**Problem.** The dashboard today only surfaces individual runs + in-flight tasks. There's no project-level view that answers "what projects do I have?" or "where am I actively working right now?".

**Shape.** New top-level dashboard page or tile: "Projects". Each project rendered as a card.

**Per-card content:**
- Project chip (color from .vscode, name from .forge/project.json if present)
- Description (from .forge/project.json) if present
- Last activity timestamp (relative: "2 hours ago", "3 days ago", "6 months ago")
- Run count + in-flight count
- 🟢 LIVE badge if \`~/.forge/orchestrators/\` has a fresh heartbeat for this projectDir (#153)
- Click → drills into the runs view filtered to this project

**Sort order:** by last activity, descending. Live projects float to the top (their last activity is "now").

**Visual states:**
- Live (orchestrator open + recent forge activity)
- Active (recent forge activity, no open orchestrator)
- Idle (no activity in >N days, no orchestrator)
- Stale (>6 months, dimmed but still visible)

**Implementation surface:**
- Dashboard server: new \`/api/projects\` endpoint returning the registry data + heartbeat status. Shape mirrors what \`forge projects list --json\` (from #152) returns, plus the heartbeat read.
- Dashboard client: new \`<ProjectsView />\` component. Uses the existing chip styling from #143.
- Routing: add a "Projects" link to the dashboard nav (alongside the existing activity feed).

**Composes with:**
- #143 (project chip color resolution) — reused for project cards.
- #151 (friendly name) — display name source.
- #152 (registry CLI) — same data source (refactored helper).
- #153 (orchestrator heartbeats) — live status badge.

**Out of scope:**
- Editing projects from the dashboard. The dashboard is read-only; mutations stay in CLI.
- Filtering / search beyond sort order. Add if it becomes painful.
- Per-project drill-down view richer than the existing runs view (yet — maybe later as a follow-up).

**Sizing.** Medium. The API endpoint is small; the client view is the bulk.

**Sequencing.** Needs #151, #152, #153 all shipped first. Comes last in the arc.

**Caught:** 2026-05-26 design conversation.