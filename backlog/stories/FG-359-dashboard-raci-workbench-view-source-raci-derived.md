---
id: FG-359
type: story
status: active
title: "Dashboard RACI Workbench: view source RACI, derived policy, effective routes, and audit history"
epic: FG-291
created: 2026-06-22
---

## Problem

The dashboard has a governance view for the effective routing-policy route matrix, but it is not yet a full RACI workbench. Operators need to understand the relationship between the SOURCE RACI, DERIVED routing-policy, EFFECTIVE project/host routes, and RECORDED audit history without running CLI commands.

## Goal

Add a read-only dashboard RACI Workbench in the Control Plane area. It should make routing governance understandable from the dashboard and use the same SOURCE / DERIVED / EFFECTIVE / RECORDED vocabulary as the broader control-plane work.

## MVP Scope

- Show the active RACI SOURCE for the selected project: project override if present, otherwise host.
- Show the DERIVED routing-policy health and path.
- Show the EFFECTIVE route matrix for the selected project.
- Show host-vs-project override comparison when a project override exists.
- Show stale compiled-policy / drift warnings.
- Show recent RACI audit entries as RECORDED governance history.
- Link or anchor route rows to their source RACI block when practical.
- Fit inside the dashboard Control Plane area alongside Sources.

## Vocabulary

- SOURCE: the human-authored RACI markdown.
- DERIVED: routing-policy.yml compiled from the RACI.
- EFFECTIVE: the route table Forge would use now for the selected project.
- RECORDED: audit-log history of applied RACI changes.

## Non-Goals

- No editing.
- No propose/apply workflow.
- No route classification changes.
- No mutation of RACI, routing-policy, or audit logs.

## Acceptance Criteria

- A human can open the dashboard and see which RACI source is active for a project.
- The view distinguishes SOURCE, DERIVED, EFFECTIVE, and RECORDED governance artifacts.
- Drift/uncompiled override states are clearly surfaced.
- Host-vs-project route differences are visible.
- Audit history remains visible.
- The view is read-only and reuses existing governance validation/query logic where possible.
