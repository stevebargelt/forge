---
id: FG-361
type: idea
status: active
title: "Dashboard RACI Editor: propose and apply RACI changes through the existing governance gate"
created: 2026-06-22
---

## Problem

Humans should rarely need to run CLI commands directly, but changing RACI governance today requires the orchestrator/CLI flow: edit a candidate file, run raci propose, inspect validation + route diff, then apply with confirmation.

A dashboard editor could make governance changes more understandable and safer for humans, but it must not bypass the existing propose/apply gate or audit trail.

## Idea

Add a dashboard RACI editor after the read-only RACI Workbench exists. The editor should let a human draft SOURCE RACI changes, run the existing governance gate, review findings and route diffs, and explicitly confirm apply.

## Required Flow

1. Edit or generate a candidate RACI source.
2. Run the same validation path as forge raci propose.
3. Show raci validate findings.
4. Show route validate findings.
5. Show route changes and source diff.
6. Require explicit human confirmation.
7. Apply through the same code path as forge raci apply --confirm.
8. Append the normal audit log entry.
9. Refresh SOURCE / DERIVED / EFFECTIVE / RECORDED dashboard views.

## Constraints

- Never write RACI directly from the editor.
- Never bypass validation.
- Never apply without explicit confirmation.
- Preserve the audit log as the source of RECORDED governance history.
- Project overrides must remain subject to host force-rule weakening checks.

## Dependency

Depends on the read-only Dashboard RACI Workbench so users understand SOURCE, DERIVED, EFFECTIVE, and RECORDED governance artifacts before editing them.

## Non-Goals

- No freeform route mutation outside the RACI source.
- No standalone routing-policy editor.
- No weakening force rules through a project override.
- No auto-apply from orchestrator suggestions.