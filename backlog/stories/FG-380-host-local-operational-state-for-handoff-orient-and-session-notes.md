---
id: FG-380
type: story
status: active
title: "Host-local operational state: /handoff, /orient, and session notes must not dirty project PRs"
created: 2026-06-23
---

## Problem

Forge currently stores too much operational memory in the project repository. In a project such as `harebrained-apps`, a feature branch can be ready to merge, but ordinary Forge/orchestrator usage such as `/handoff` or `/orient` modifies tracked backlog/session files. That creates unrelated git noise in the project PR and makes "ready to merge" fragile.

The repo-backed backlog is useful for durable product intent: stories, acceptance criteria, closed decisions, and PR-visible planning. But Forge operational state is different. Session handoff notes, orientation breadcrumbs, "picked up next" notes, reviewer/orchestrator scratch state, and resume context are host-local runtime state. They should not dirty a project branch by default.

## Goal

Separate durable repo-backed backlog content from host-local Forge operational state so passive commands like `/handoff`, `/orient`, review, and resume do not modify tracked project files unless the operator explicitly asks to edit the backlog.

Core invariant:

> Opening, orienting, handing off, reviewing, or resuming work must not modify tracked project files by default.

## Design Direction

- Keep `backlog/stories/*.md`, epics, ideas, and explicit backlog edits repo-backed when a project wants planning artifacts in git.
- Move operational/session state to host-local storage, likely under a stable per-project path such as `~/.forge/projects/<project-id>/`.
- The project id should be stable across sessions and should not collide for same-basename projects in different directories.
- Dashboard and CLI should surface host-local handoff/orientation state so humans do not need to inspect files manually.
- Mutating tracked backlog files should require explicit commands such as `forge backlog file`, `forge backlog edit`, `forge backlog close`, or an explicit orchestrator action.
- `/handoff` and `/orient` should become read-mostly/project-clean operations by default.

## Acceptance Criteria

- Define which current files/commands are durable project backlog versus operational Forge state.
- Design a host-local storage location and project identity scheme for operational state.
- `/handoff` no longer modifies tracked project files by default.
- `/orient` no longer modifies tracked project files by default.
- Passive review/resume/orientation flows do not dirty `git status` in the project.
- Explicit backlog mutations still update the repo-backed backlog when requested.
- Existing projects with repo-backed handoff/orientation notes have a migration or compatibility story.
- Dashboard or CLI can display the host-local handoff/orientation state.
- Tests cover a project with a clean git branch where `/handoff` and `/orient` leave `git status` clean.

## Non-Goals

- Do not remove repo-backed backlog support.
- Do not hide explicit backlog edits from git.
- Do not require humans to manage host-local files directly.
- Do not solve full multi-machine synchronization of host-local operational state in the first cut.

## Relations

- Related to FG-367: Forge-managed project git discipline.
- Related to FG-372: Shipping Reviewer should check that operational closeout did not dirty unrelated project files.
- Related to FG-363: Dashboard backlog viewer; future dashboard surfaces should distinguish repo backlog from host-local operational state.
