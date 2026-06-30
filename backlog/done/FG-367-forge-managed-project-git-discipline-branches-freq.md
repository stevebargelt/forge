---
id: FG-367
type: story
status: done
title: "Forge-managed project git discipline: branches, frequent commits, and PRs by default"
epic: FG-291
created: 2026-06-22
closed: 2026-06-30
closed_commit: bb1f1b8
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

## Decision — v1 scope + policy (settled at architect gate, 2026-06-29)

Conservative v1, scoped to truthful git-evidence surfacing on operator/campaign-report surfaces. The original "Dashboard Requirements" PR-state UI is NOT part of this v1 (separate dashboard work); v1 acceptance is the operator/campaign-report layer + policy + the no-remote truthfulness fix.

- **No auto-push, no auto-PR.** Forge records what it actually managed (branch created, worktree merged) and surfaces push/PR readiness truthfully; the operator remains responsible for push/PR in v1. Auto-push/auto-PR is a later explicit opt-in ticket, never hidden behavior here. No `git push` or PR command is invoked.
- **One source of truth for push status** (option 1): do NOT add `push_state`/`pr_state` columns. Pushed truth stays sourced from done-audit / git facts. Derived labels (`not_pushed` / `no_remote` / `unavailable`) MAY be rendered in human + JSON output, but DERIVED from existing audit/git facts, not persisted as a second source.
- **Fix the local-only bug:** if no remote is configured, `pushed` is unknown/`no_remote`, NOT fail (collect.ts must `git remote`-check before `git branch -r --contains`, mirroring upgrade.ts).
- **branch/worktreePath:** populate the existing campaign fields ONLY when Forge actually manages a worktree (e.g. `FORGE_WORKTREES=1`). In non-worktree/default mode leave them null — do not imply Forge managed the current branch. These fields are NOT done-audit inputs.
- **closedCommit gap-fill:** allowed only when the ticket is already `done` AND closedCommit is absent; use a NARROW frontmatter update — do not rewrite the closed date or other ticket fields; never overwrite an agent-supplied SHA.
- **No destructive git operations.**

Required tests (real git): no-remote → pushed unknown/no_remote (not fail); remote-but-unpushed → not_pushed/failure as appropriate; worktree campaign records branch/worktreePath; non-worktree campaign leaves them null; no `git push`/PR command invoked; closedCommit fill does not alter the closed date.

Key principle: one source of truth for push status, no automation that changes remote state, truthful reporting when Forge cannot know.
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
