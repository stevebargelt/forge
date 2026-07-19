---
id: FG-544
type: story
status: done
title: Orchestrator-owned concurrent research lane using dedicated task branches and worktrees
created: 2026-07-12
closed: 2026-07-19
---

**Disposition (2026-07-19):** Close as superseded by the general operator queue and capacity-limited dispatcher model (FG-591/FG-593), with shared workspace-isolation and publication machinery. Research should not require a special parallel-lane architecture.

## Problem

Forge should be able to run repository-producing research concurrently with implementation, under the same primary orchestrator. The current `research_only` campaign lane dispatches through the single-invoke escape-hatch path and does not establish a dedicated orchestrator-owned branch/worktree lifecycle. Independent research sessions can therefore acquire the live checkout or check out `main` in another worktree, making active work invisible to the orchestrator, blocking branch checkout, and leaving stale Git artifacts.

Research is ordinary writable repository work when its deliverable is a note or document. It needs the same ownership, isolation, provenance, integration, and cleanup guarantees as implementation work; it does not need an external sidecar control plane.

## Goal

Make repository-producing research a first-class orchestrated concurrent lane. The primary orchestrator owns its task branch/worktree, tracks it durably, and integrates its output through normal commit/review/refinery behavior without allowing a research agent to reserve `main` or mutate the live checkout.

## Acceptance Criteria

- A primary campaign/orchestrator can dispatch a `research_only` item concurrently with an implementation item while retaining durable visibility of both.
- Each repository-producing research task is created from a recorded exact base SHA on a dedicated orchestrator-owned task branch and worktree.
- A research task never checks out, reserves, or moves `main` or another shared named branch; the primary repository remains able to keep `main` checked out.
- The research agent writes files in its assigned worktree but is not instructed or permitted to create branches, switch branches, commit, merge, close tickets, or clean up Git state. Commit/integration/cleanup remain orchestrator responsibilities.
- Campaign/run status and reports expose the research task, source SHA, branch, worktree, lifecycle state, and resulting artifact paths.
- Completed research enters the normal ordered integration/refinery path. Conflicts are retained and surfaced as blockers rather than silently resolved or discarded.
- Failure, cancellation, retry, and reconcile paths preserve recoverable research output and remove worktrees/branches only when no unmerged work can be lost.
- Concurrency policy either proves two lanes safe to overlap or serializes their integration; it must not infer safety merely from the `research_only` label.
- Tests prove: research and implementation can be active together; `main` remains available; agents cannot mutate shared refs; integration is ordered; and success/failure cleanup leaves no stale worktree or branch.
- Advisory research that intentionally produces no repository changes may remain read-only, but that is an explicit mode and not a substitute for the writable research lifecycle.

## Non-Goals

- A second independent orchestrator for research.
- A research-specific artifact store replacing Git for repository documents.
- Shipping general unrestricted parallel campaign implementation beyond the bounded research lane.

## Relations

- Slice of FG-396 (parallel campaign lanes and merge/refinery behavior).
- Related to FG-430 (campaign autonomy model).
- Related to FG-291 (research-synthesis visibility).
- Related to FG-422 (deep-research workflow conventions).
- Pair with FG-545 (docs/research-only CI fast path).
