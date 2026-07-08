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

The inverse failure is now recurring too: because backlog items are ordinary git files, new or edited tickets can exist only in one dirty worktree until someone notices, commits, and pushes them. A later Forge run, campaign worktree, review-loop restore, or handoff/orient from another checkout can then say the ticket "does not exist" or silently lose the operator's latest backlog intent. Example: FG-495 was visible in the current working tree but untracked, so a clean Forge worktree correctly could not see it until the backlog file was committed and pushed.

## Goal

Separate durable repo-backed backlog content from host-local Forge operational state so passive commands like `/handoff`, `/orient`, review, and resume do not modify tracked project files unless the operator explicitly asks to edit the backlog.

Also make explicit backlog mutations durable as mutations: when Forge files/edits/closes a repo-backed backlog item as part of a run, it must either commit/push that backlog change through the normal branch/PR/merge path or clearly surface that the backlog has uncommitted durable-intent changes that other Forge worktrees will not see.

Core invariant:

> Opening, orienting, handing off, reviewing, or resuming work must not modify tracked project files by default.

## Design Direction

- Keep `backlog/stories/*.md`, epics, ideas, and explicit backlog edits repo-backed when a project wants planning artifacts in git.
- Move operational/session state to host-local storage, likely under a stable per-project path such as `~/.forge/projects/<project-id>/`.
- The project id should be stable across sessions and should not collide for same-basename projects in different directories.
- Dashboard and CLI should surface host-local handoff/orientation state so humans do not need to inspect files manually.
- Mutating tracked backlog files should require explicit commands such as `forge backlog file`, `forge backlog edit`, `forge backlog close`, or an explicit orchestrator action.
- Explicit backlog mutations should not be left as invisible local-only state. Forge should record whether a backlog mutation is committed/pushed, PR-bound, or intentionally local, and handoff/orient should surface any uncommitted repo-backed backlog changes as a real durability hazard.
- `/handoff` and `/orient` should become read-mostly/project-clean operations by default.

## Acceptance Criteria

- Define which current files/commands are durable project backlog versus operational Forge state.
- Design a host-local storage location and project identity scheme for operational state.
- `/handoff` no longer modifies tracked project files by default.
- `/orient` no longer modifies tracked project files by default.
- Passive review/resume/orientation flows do not dirty `git status` in the project.
- Explicit backlog mutations still update the repo-backed backlog when requested.
- Explicit repo-backed backlog mutations made by Forge are durable before another clean-worktree run is expected to consume them: either committed/pushed, included in the current PR/branch plan, or reported in a prominent "local-only backlog changes" warning.
- `forge backlog file/edit/close` and orchestrator-driven backlog changes make the visibility/durability state clear in command output or handoff: local-only, committed-not-pushed, pushed, or PR-bound.
- Review-loop tree restore, campaign worktrees, and autonomous handoffs do not silently discard untracked or modified backlog files; before any operation that resets/restores the tree, Forge checks for repo-backed backlog changes and either preserves them, commits them through the intended path, or refuses with guidance.
- Existing projects with repo-backed handoff/orientation notes have a migration or compatibility story.
- Dashboard or CLI can display the host-local handoff/orientation state.
- Dashboard or CLI can show repo-backed backlog durability hazards separately from ordinary code dirtiness, so "FG-495 exists only locally" is visible before another run depends on it.
- Tests cover a project with a clean git branch where `/handoff` and `/orient` leave `git status` clean.
- Tests cover filing a backlog item, then simulating a clean secondary worktree/read: Forge surfaces that the new ticket is local-only until committed/pushed instead of letting a later run fail mysteriously with "ticket does not exist."

## Non-Goals

- Do not remove repo-backed backlog support.
- Do not hide explicit backlog edits from git.
- Do not require humans to manage host-local files directly.
- Do not solve full multi-machine synchronization of host-local operational state in the first cut.
- Do not move durable backlog tickets entirely out of git in this story. The boundary is: durable product intent remains repo-backed when requested; operational/session state becomes host-local; repo-backed backlog mutations get explicit durability handling.

## Relations

- Related to FG-367: Forge-managed project git discipline.
- Related to FG-372: Shipping Reviewer should check that operational closeout did not dirty unrelated project files.
- Related to FG-363: Dashboard backlog viewer; future dashboard surfaces should distinguish repo backlog from host-local operational state.
