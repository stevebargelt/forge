---
id: FG-367
type: story
status: active
title: "Forge-managed project git discipline: branches, frequent commits, and PRs by default"
epic: FG-291
created: 2026-06-22
---

## Problem

Forge agents can make useful changes across any managed project, but the surrounding git discipline is still too dependent on the human operator or on each agent remembering the right habits. That is risky as Forge becomes more autonomous: unbranched work, sparse commits, missing PRs, and unclear upstream state make it harder to review, recover, bisect, or hand work back to humans.

This applies to all Forge-managed projects, not only Forge developing Forge.

## Goal

Make branch/commit/PR discipline an orchestrator-managed default for mutating Forge work. Humans should rarely need to run git commands directly; Forge should preflight the repo state, choose or create the right branch, commit meaningful increments, surface the git state in the dashboard, and open or prepare PRs when the project has an upstream.

## Proposed Policy

- Mutating runs should happen on a non-default branch unless the project explicitly opts out.
- Forge should detect repository, branch, dirty-state, default-branch, and upstream/remote status before dispatch.
- The orchestrator should create or select a run/task branch using a deterministic naming scheme.
- Agents should commit completed, coherent increments often enough that recovery and review are practical.
- Forge should open a PR, or prepare a PR-ready branch, for completed mutating work when an upstream remote exists.
- Projects with no upstream remote should still get branch and commit discipline, with dashboard state explaining that no PR can be opened yet.
- Non-git projects, throwaway spikes, read-only research, and explicitly local-only work need clear escape hatches.

## Dashboard Requirements

- Show the active branch for a run.
- Show whether Forge created the branch or reused an existing one.
- Show dirty-state / uncommitted-change warnings before dispatch.
- Show latest commit(s) produced by the run.
- Show PR state when available: not applicable, ready to open, opened, merged, blocked, or failed.
- Explain required human action in the dashboard rather than assuming the human will run CLI commands.

## Non-Goals

- Do not require worktrees in this story.
- Do not build a full merge queue.
- Do not force PR creation for projects without a configured upstream remote.
- Do not solve branch protection, CI provider integration, or GitHub/GitLab/Bitbucket API depth beyond what is needed for a first useful PR path.
- Do not remove the CLI; the dashboard/orchestrator path is the primary human-facing path.

## Open Design Questions

- Should the default branch naming scheme be run-scoped, task-scoped, backlog-item-scoped, or configurable per project?
- What is the minimum useful commit cadence: after each task, after each phase, after each green validation point, or agent-controlled with orchestrator enforcement?
- Should Forge use the hosting provider API to open PRs in the first cut, or produce a dashboard-visible "PR ready" state with the exact command/action as a fallback?
- How should Forge handle a dirty starting tree: block by default, snapshot to a prep commit, or allow with explicit operator approval?
- Which workflows are read-only enough to skip branch creation by default?

## Acceptance Criteria

- Forge can classify a run as mutating or read-only before dispatch.
- For mutating git projects, Forge refuses or clearly gates dispatch when branch/upstream/dirty-state policy is not satisfied.
- A mutating run on a git project uses a non-default branch by default.
- Completed mutating work leaves behind reviewable commits with task/run provenance.
- When an upstream remote exists, Forge can surface PR-ready or PR-opened state in the dashboard.
- When no upstream remote exists, Forge clearly explains that PR creation is not available and still preserves branch/commit discipline.
- Dashboard users can understand branch, commit, and PR state without running git commands.
- Policy escape hatches are explicit, recorded, and visible in the run/control-plane receipts.
