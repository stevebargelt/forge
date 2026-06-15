---
id: FG-132
type: story
status: done
title: BACKLOG.md as project state is brittle; fast-follow to v2 with a thin CLI + SQLite-backed storage
---

**Closed:** 2026-05-14. Commit `1ae5278`.

**Why:** Caught 2026-05-14 during the v2 RACI design pairing. BACKLOG.md is forge's single source of truth for tickets, session notes, and project state. It works today but has structural problems that grow with use:

1. **Unbounded growth.** Already ~57k tokens / ~1700 lines. The orchestrator reads it as orientation on every session start, burning context proportional to file size. Most of that is historical noise (Done-archived entries from months ago).
2. **No native query.** "All tickets touching the dashboard from the last 30 days" requires grep + parse, not query.
3. **Single-writer assumption.** As soon as agents in containers want to file follow-ups (today: the orchestrator does it on their behalf, in conversation), concurrent markdown edits silently conflict.
4. **Tight coupling.** Every consumer (orchestrator, dashboard, future agents) needs to parse 1700 lines of free-form markdown. No stable API.
5. **Brittle to schema drift.** Sticky IDs work because everyone agrees on the format. One bad merge breaks ID parsing across the whole history.

**Steven's call (2026-05-14):** "We may need to revisit BACKLOG.md as the sole source for the project info/issues. Seems brittle and will grow uncontrollably. Eventually we can tap into Jira and/or github issues... not quite yet though (corporate policies)."

**The right shape — two-phase migration:**

**Phase A (fast-follow to v2): thin `forge backlog` CLI over the existing markdown.**
- Commands: `forge backlog list [--status active|done] [--touches <path>]`, `forge backlog show <id>`, `forge backlog file <title> [--body -]`, `forge backlog close <id> [--commit <sha>]`, `forge backlog move <id> <section>`, `forge backlog notes [add|show]`
- The CLI reads/writes BACKLOG.md today, but **callers (orchestrator agent, dashboard, in-container agents) only see the CLI surface**. They don't parse markdown directly.
- Bonus discipline: notes-for-next-session caps at N entries (say 5); older notes archive to `learnings/session-notes/<date>.md`. Done-archived entries get *moved out* to `learnings/done-archived.md` rather than growing inline.
- Buys ~12-24 months before real DB pressure.

**Phase B (when phase A's discipline isn't enough OR when corporate policy unlocks Jira/GitHub):** swap the storage backend.
- Option (i): SQLite-backed. New `tickets` table in `~/.forge/forge.db`. BACKLOG.md becomes a *generated view* — projected from the DB, regenerated on writes, committed for the human-readable artifact. Native query/filter/search. Dashboard gets a "Tickets" view alongside Runs.
- Option (ii): GitHub Issues. Forge becomes a client of the project's GitHub repo's Issues. Sticky IDs become GitHub issue numbers. Pro: zero forge-maintained storage. Con: corporate-blocked today; requires network access at agent-invocation time.
- Option (iii): Jira. Same shape as (ii) but Jira. Same corporate-policy concerns.

**Why the two-phase split matters:** The `forge backlog` CLI surface stays the same across all three Phase-B options. Callers never change. Storage swap is internal. Migration cost = "write the new backend behind the existing CLI."

**What to ship in Phase A specifically:**
1. `src/cli/commands/backlog.ts` with the verbs above
2. A parser for the existing BACKLOG.md format (sections, sticky IDs, frontmatter-free markdown bodies)
3. Discipline-enforcement hooks: notes-cap, done-archived-archival
4. Orchestrator template update: orchestrator uses `forge backlog` commands instead of reading BACKLOG.md whole. (Big context win.)
5. `forge backlog migrate` once we move to phase B — projects existing markdown into the new backend in one shot.

**Composes with v2 cutover (#116):**
- v2's runner + invoke + orchestrator pattern lands first
- This is the **immediate** next architectural lift after v2 — the orchestrator can't be efficient at session start if it's reading 57k tokens of markdown
- Net context-window savings make this almost pay for itself in cost reductions

**Not blocking:** v2 ships with BACKLOG.md-as-markdown; this lands soon after. Don't conflate.

**Caught:** 2026-05-14 — during the v2 RACI design conversation, the "Informed = file" question surfaced that BACKLOG.md was being used as both a notification target AND project state, and neither fits cleanly.