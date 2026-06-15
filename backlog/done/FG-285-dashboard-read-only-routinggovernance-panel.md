---
id: FG-285
type: story
status: done
title: "Dashboard: read-only routing/governance panel"
---

**Closed:** 2026-06-05.

**Epic:** #273. **Depends on:** #281.

Surface the active RACI-derived routing policy in the dashboard as observability, not control. The dashboard is currently an information-only surface and should stay that way for the near future; routing/governance visibility should show how Forge will route work for the current project without introducing a second RACI edit path.

Scope:
- Add a read-only dashboard panel/view backed by the same effective-governance data as `forge route governance --json`.
- Show the effective policy source (`host` vs `project`), policy path, validity/staleness state, and the accountable header.
- Render the route matrix: route key / work type, path, responsible target, command when applicable, consulted evidence or agents, required followups, informed targets, force rules, and classification hints.
- When a project override is active, show the host-vs-project route diff and clearly distinguish added, removed, and modified routes.
- Warn on uncompiled project overrides, missing policies, invalid policies, and policy/RACI drift instead of showing a clean-looking route table.
- Show recent RACI audit entries if available, so policy changes are visible without reading `~/.forge/raci-audit.log`.

Non-goals:
- No dashboard mutation, apply buttons, merge buttons, raw policy editing, or RACI editing in this story.
- No prompt classification by code; an "explain route" selector may look up an exact route key only, matching `forge route explain`.
- No full provider-adapter generation; #283 owns rendering provider-specific surfaces from the policy.

Acceptance:
- Dashboard displays the same effective route data as the route governance CLI/API for host-default routing.
- Dashboard displays project override source and host-vs-project diff when opened from a project with `<project>/.forge/routing-policy.yml`.
- Dashboard surfaces uncompiled override / missing policy / invalid policy / drift findings as warnings or errors, not as a normal healthy table.
- Tests cover host default, project override diff, and at least one unhealthy state.
- The dashboard remains read-only; there is no write endpoint and no UI control that mutates RACI or routing policy.

Relations: #273, #281, #280, #279, #284.