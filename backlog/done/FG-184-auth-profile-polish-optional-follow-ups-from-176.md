---
id: FG-184
type: story
status: done
title: "Auth-profile polish (optional follow-ups from #176)"
closed: 2026-06-19
---

Optional refinements after the #176 auth-profile epic shipped (none blocking):

- **Upstream PR**: open a PR of `feat/preload-storage-state` from the fork (github.com/stevebargelt/pi-skills) to `badlogic/pi-skills`. The injector is generic now (keyed on BROWSER_TOOLS_STORAGE_STATE); if merged, forge could drop the fork and pin upstream instead (#181).
- **browser-content.js + --new-tab**: only `browser-nav.js` calls `maybeApplyAuth`. `browser-content.js` (and any other navigating script) doesn't, so auth doesn't apply there. New-tab navigation re-registers the init script per nav (harmless duplicate). Wire the helper into the other nav paths if those surfaces need auth.
- **Per-step auth flag**: pipeline scoping is a hardcoded role allowlist (`roleUsesBrowser`: engineer, frontend-specialist, test-engineer, manual-qa). A `needs_auth: true` step field in the workflow schema would be more precise if a non-listed role ever needs to browse authenticated, or to exclude an in-list role for a given workflow.
- **pi-skills whole-repo pin**: forking all of pi-skills pins every skill to the branch snapshot; if other skills need upstream updates, split browser-tools out or rebase periodically.