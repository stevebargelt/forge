# Operator Surface Addons

**Status:** concept / roadmap. This note has no implementation authority.

Forge's core loop should stay focused on orchestrating work: runs, tasks, gates, agents, routing, verification, and durable state. Operator surfaces are different. They make Forge easier to see, supervise, and enjoy using, but they should not become load-bearing runtime behavior.

An **operator surface addon** is an optional human-control surface around Forge. Examples:

- Stream Deck profiles and icons.
- Raycast or Alfred shortcuts.
- Shell aliases.
- Menu bar tools.
- Mobile shortcuts.
- Project-specific dashboard launchers.

These are not a plugin model. They are optional kits that sit beside Forge and call into stable Forge surfaces.

## Core Versus Addon

Forge core should own:

- stable dashboard URLs;
- safe read-only status endpoints;
- project identity and current-project resolution;
- explicit commands for safe actions;
- optional setup/init scaffolding;
- documentation and templates.

An addon should own:

- personal button layouts;
- profile exports;
- icons and visual style;
- local wrapper scripts;
- machine-specific paths;
- private/private-team conventions.

This keeps Forge portable while allowing highly personal operator workflows.

## Setup Shape

`forge setup` or `forge init` may eventually offer optional operator-surface scaffolding:

```text
Configure optional operator surfaces?
- Stream Deck profile kit
- Raycast/Alfred shortcuts
- Shell aliases
- None
```

For Stream Deck, the preferred shape is a separate private repo or host-local directory, not tracked project files:

```text
~/code/forge-streamdeck-control/
  profiles/exported/
  profiles/reviewed/
  icons/source/
  icons/png-144/
  scripts/
  streamdeck-buttons.md
```

Forge can store a host-local pointer to that repo under `~/.forge`, but project repos should not contain personal Stream Deck exports or machine-specific paths.

## Safety Rules

- Addons should start with dashboard-opening and read-mostly actions.
- Agents may edit reviewed artifacts under Git, but must not mutate live app support directories by default.
- Destructive or judgment-heavy actions should open a decision screen with context, not execute on one tap.
- Do not put secrets, private profile exports, or machine-specific credentials in the public Forge repo.
- Forge must remain operable without any addon installed.
- An addon that surfaces **current activity** reads Forge's own read-only surfaces (`forge status`, the dashboard's `/api/current-activity`) rather than re-deriving activity from `forge launch list`, `tmux`, `docker`, or a GitHub token of its own. Those all exist; the point is that Forge already answers this question from durable state, and a second derivation is a second thing to be wrong.
- An addon must not compress the launch status vocabulary. `terminated by SIGTERM (signal sender not recorded — origin unknown)`, `exited 143 (signal-range code, no signal evidence — origin unknown)`, `owner gone`, and `unknown` are four different facts, and **exit 143 alone is never attribution evidence**. A red button that means "failed" for all four is a worse surface than no button — see `docs/concepts.md` → Current activity.
- A stale observation is not a green light and not a red one. Render `unobserved since <time>` as itself; it is a fact about the observer, not about the work. The same discipline applies to required CI, where `not observed` (nobody looked), `not running` (looked, nothing pending), and `stale` (an old observation) are three different answers an addon must not merge into one lamp.

## Stream Deck First Page Ideas

- Needs Me: open dashboard filtered to human action required.
- Active Runs: open the current project/run dashboard.
- Backlog: open the dashboard backlog viewer.
- RACI: open the RACI viewer.
- Reconcile: open ops/reconcile candidates.
- Handoff / Orient: open host-local operational state once available.
- Review / Done Audit: open Shipping Reviewer readiness/done-audit state.
- Pause Queue / Resume Queue: once work queue/campaign support exists.

The goal is not to make humans run CLI commands from buttons. The goal is to make Forge more visible, tactile, and easier to supervise.
