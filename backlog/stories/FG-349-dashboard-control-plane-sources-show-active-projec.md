---
id: FG-349
type: story
status: active
title: "Dashboard Control-Plane Sources: show active project/host config and override provenance"
epic: FG-291
created: 2026-06-22
---

## Problem

Forge has several config layers: project overrides, host-installed config, repo seeds/templates, routing policy, model policy, workflow YAML, runtime YAML, constraints, docs surfaces, agents, and auth profiles.

Humans should rarely need to run CLI commands to understand which config is actually active. Today the operator has to mentally join filesystem state, Forge home state, seed drift, and project override rules.

## Goal

Add a dashboard Control-Plane Sources view that shows the effective config for a selected project and host, with clear provenance and warnings.

This answers: What configuration would Forge use if I started a run here?

## MVP Scope

Show, for the selected project:

- project directory and workspace identity
- Forge home path
- workflow source: project override vs host default
- runtime source: project override vs host default
- model-policy source: project override vs host vs absent legacy mode
- routing-policy source: project override vs host
- RACI source and stale/compiled state
- docs-surfaces source: project override vs built-in defaults
- constraints source and count
- installed agents and missing expected agents
- installed workflows and missing expected workflows
- seed drift summary
- auth/profile availability summary if cheap and non-mutating

Each row should label status:

- active
- absent
- overridden
- template only
- derived
- stale
- missing
- warning

## UX Notes

This should be a grouped provenance table, not necessarily a visual graph.

When a project override exists, call out that it fully replaces the host file.

Example:

`project .forge/model-policy.yml active — fully replaces host ~/.forge/model-policy.yml`

## CLI/API Shape

Dashboard should call a structured API/query.

A CLI JSON command can exist for the orchestrator:

`forge config graph --project . --json`

Human-readable CLI output is secondary.

## Non-Goals

- No config editing.
- No setup wizard.
- No mutation or seed refresh.
- No natural-language routing classification.
- No replacement for the Run Map explain panel.

## Acceptance Criteria

- Dashboard shows which config files are active for a project.
- Project overrides are obvious and explain replacement semantics.
- Seed/template files are clearly distinguished from active installed config.
- Stale or missing derived routing/RACI state is surfaced.
- Legacy/no-policy model mode is labeled clearly.
- View is read-only.
- Same structured data is available to the orchestrator as JSON.
