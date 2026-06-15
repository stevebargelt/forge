---
id: FG-123
type: story
status: done
title: "Dashboard a11y posture: System Map (and broader dashboard) lacks focus indicators, aria-labels, non-color status signals"
---

**Closed:** 2026-05-26. Deferred — no real users with a11y needs yet; dashboard is solo-developer-on-localhost. Revisit when (if) the dashboard ships to anyone else. Ticket body kept for the original audit findings and proposed scope.

**Why:** Caught 2026-05-13 by red-build-5b7129 during System Map (#105) red review. Six findings on the System Map specifically: filter chips lack visible focus indicators for keyboard navigation; modal is a keyboard trap with no visible escape path in keyboard focus order; HTML node labels signal status via color only (no secondary indicators / no sufficient text contrast); filter chips + close button lack aria-labels; cytoscape canvas container is a generic div with no accessible semantics or labeling; progress bar has no accessible text alternative. **All legitimate**, but **not System-Map-specific** — this is the broader dashboard's a11y posture, which has never been audited. The findings would surface on any other dashboard view too.

**Why not blocking #105:** the PRD didn't require a11y; the dashboard's existing surfaces have the same gaps; an a11y pass is a cross-cutting concern that deserves its own dedicated work, not a dashboard-feature-by-dashboard-feature bolt-on.

**How to apply (when):**
- Audit the dashboard as a whole, not the System Map in isolation. Pill row, task list, task detail, gate UI, run-new modal, auth indicator — every interactive surface gets the same treatment.
- Focus indicators: `:focus-visible` styles via CSS for all interactive elements. Not specific to one view.
- aria-labels on icon-only buttons + dynamic regions on the live-updating task pane.
- Keyboard navigation map: confirm tab order makes sense, Esc closes modals, no traps.
- Color + non-color status signaling: status badges already carry text ("complete" / "running"), so much of the color-only finding is incorrect-on-inspection — but the System Map's node label is the most color-heavy, would benefit from a glyph or text-label secondary signal.

**Sequencing:** post-#105 cleanup. Probably 1-2 days of focused work; not urgent, not in scope until a real user with an accessibility need surfaces.

**Caught:** 2026-05-13 — red review of System Map build.