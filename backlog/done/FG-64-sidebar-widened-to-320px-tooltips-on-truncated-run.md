---
id: FG-64
type: story
status: done
title: Sidebar widened to 320px + tooltips on truncated run ids
---

**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — pure UI, no test deltas).
- `#app` `grid-template-columns` bumped from `280px 360px 1fr` to `320px 360px 1fr`. Common kebab-cased run ids (`run-test-prompt-author-v3-da7d57`, ~32 chars) stop truncating in the sidebar.
- Sidebar runRow now carries `title="<full id> — <title>"`, hoverable for the full id even when wider names truncate.
- Run-pane breadcrumb shortId span carries `title="<full id>"` for the same reason.
- Draggable resizers (option a from BACKLOG #64) deferred — option b shipped as a 10-line fallback.

### #62 + #63 — Human-led gate copy fork + fresh-session warning
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — pure UI, no test deltas).
- **#62 (gate copy fork):** `gateActionsSection` reads `phaseShape` to detect human-led phases (`isManual: true`). Three button-shape branches now: blocked-by-red (existing), human-led (new), agent-led (existing). Human-led branch shows two buttons — "✓ I've done the work" + "✕ I've decided not to do this" — and skips the request-changes middle option (which gate.ts rejects on manual phases anyway because there's no agent to re-dispatch). Rationale label changes to "Notes — optional on confirm, required on send-back / stop." Same primitive, different verbs.
- **#63 (fresh-session warning):** awaiting_gate brief tasks now render a yellow warn alert above the rationale: "⚡ Run the PROMPT.md in a fresh Claude Code session before approving. Don't paste into a session already mid-task — long structured prompts can silently drop trailing sections when the running session compacts mid-run." Caught 2026-05-08 during FOLLOWUP-PROMPT.md run.
- Detail render-key already includes the slim phaseShape signal from #71, so this picks up phaseFilter changes naturally.
- New `findPhaseShape(phaseName)` helper looks up the phase in `state.runDetail.phaseShape` (also useful to future copy/icon variants).