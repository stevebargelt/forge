---
id: FG-387
type: idea
status: active
title: "Stream Deck operator control surface for Forge"
created: 2026-06-23
---

## Problem

I have a Stream Deck that is underused, and Forge increasingly needs a low-friction human operator surface. The goal is not to make humans run CLI commands from buttons. The useful shape is a physical attention/control console: show what needs me, jump to the right dashboard screen, and trigger safe/read-mostly orientation or handoff flows.

Relevant inspiration:

- Patrick Isenegger article: https://patrickisenegger.com/en/posts/2026-05-18-managing-stream-deck-icons-with-codex-or-claude/
- Companion repo: https://github.com/PatrickIsenegger/streamdeck-agent-workflows

Key lesson from that repo: agents should manage exported/reviewed artifacts, icons, inventories, and scripts under Git. They should not directly mutate the live Stream Deck application support directory.

## Idea

Explore a Forge-specific Stream Deck operator console, likely maintained in a separate private repo such as `forge-streamdeck-control`, using the exported-artifact workflow from the companion project.

This should be treated as an **operator surface addon**, not Forge core runtime and not a generic plugin system. Forge core should provide stable dashboard URLs, safe/read-only status endpoints, project identity, and optional scaffolding. The Stream Deck addon should own profile exports, button layout, icons, local wrapper scripts, and any personal/private paths.

Possible setup framing:

- `forge setup` or `forge init` may offer optional operator-surface scaffolding.
- Stream Deck should be one optional kit alongside future surfaces such as Raycast, Alfred, shell aliases, menu bar tools, or mobile shortcuts.
- Forge can store a pointer to a private operator-surface repo in host-local config, for example `~/.forge/addons/streamdeck` or a user-selected `~/code/forge-streamdeck-control`.
- Do not require a full plugin model before proving the value of one operator-surface kit.

Initial useful buttons/pages:

- Needs Me: open dashboard filtered to human action required (`awaiting_gate`, `blocked_by_red`, `needs_human`, failed runs).
- Active Runs: open current project/run dashboard.
- Backlog: open dashboard backlog viewer.
- RACI: open dashboard RACI viewer.
- Reconcile: open ops/reconcile candidates, not auto-mutate.
- Handoff / Orient: once FG-380 host-local state lands, trigger or display safe host-local handoff/orientation state without dirtying the project repo.
- Review / Done Audit: once FG-372 children land, open Shipping Reviewer readiness/done-audit state.
- Pause Queue / Resume Queue: once work queue/campaign support exists.

## Safety Model

- Start with dashboard-opening/read-mostly actions.
- Keep live Stream Deck profile import/manual testing human-controlled.
- Agents may edit reviewed profile exports, icons, button inventories, and scripts in a separate repo.
- Do not allow agents to modify the live Stream Deck config directory.
- Avoid one-tap destructive/judgment actions such as advance gate, cancel run, merge PR, or request changes. Those should open a decision screen with context and require confirmation.

## Spike Acceptance

- Inventory the first Forge Stream Deck page and button semantics.
- Decide whether to fork/adapt the companion repo layout or create a small Forge-specific private repo using the same pattern.
- Decide what Forge core must expose versus what belongs in the optional addon repo.
- Decide whether `forge setup` / `forge init` should offer optional scaffolding and where host-local addon config should live.
- Create a first reviewed profile/icon draft or design doc.
- Define the dashboard URLs or safe commands each button would trigger.
- Identify what requires future Forge API/dashboard work for dynamic labels.
- Explicitly document safety boundaries and non-goals.

## Non-Goals

- Do not build a full Stream Deck plugin in the first cut.
- Do not automate live profile mutation.
- Do not put private Stream Deck exports, machine-specific paths, or secrets in the public Forge repo.
- Do not make Stream Deck buttons the only way to operate Forge.

## Relations

- Related to FG-291 dashboard/operator baseline.
- Related to FG-380 host-local operational state.
- Related to FG-372 Shipping Reviewer / done-audit surfaces.
- Related to FG-370 work queue / campaign runner.
- Concept note: docs/operator-surface-addons.md.
