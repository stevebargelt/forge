---
id: FG-438
type: story
status: done
title: "Dashboard Projects: project cards link to each project GitHub repo"
created: 2026-07-02
closed: 2026-07-05
closed_commit: 825d8bbb5d3d5806d38a145ac87b49587acee205
---

## Problem

The dashboard Projects view shows project cards, but the cards do not provide a direct link to the project's GitHub repository. Operators looking at a project in Forge have to switch to a terminal or manually locate the repo URL before opening GitHub.

## Goal

Each project card in the dashboard Projects view links to the project's GitHub repository when Forge can derive a GitHub remote for that project.

## Acceptance Criteria

- For each project card, the dashboard derives the project's GitHub repository URL from the project directory's git remotes when available.
- The link opens the canonical browser URL, not the raw git transport URL. Examples:
  - `git@github.com:owner/repo.git` -> `https://github.com/owner/repo`
  - `https://github.com/owner/repo.git` -> `https://github.com/owner/repo`
- If multiple remotes exist, prefer `origin`; otherwise use the first GitHub remote found.
- If no GitHub remote is available, the card renders without a broken/empty link.
- The link is visually discoverable on the card but does not interfere with existing project-card click/selection behavior.
- Tests cover SSH remote, HTTPS remote, `.git` suffix trimming, no-remote/no-GitHub cases, and multiple-remotes preference.

## Non-Goals

- Does not add GitHub API calls or require authentication.
- Does not link to non-GitHub providers in this ticket.
- Does not change project discovery semantics.

## Notes

This should be implemented as a read-only dashboard/operator convenience. Avoid shelling out per card on every poll if the existing projects query already has a suitable place to derive/cache project metadata.