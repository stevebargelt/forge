---
id: FG-376
type: story
status: done
title: "Agent worktree dependency parity: real node_modules in disposable worktrees so agents/reviewers can run normal tests"
epic: FG-291
created: 2026-06-23
closed: 2026-07-02
closed_commit: 7211a47
---

## Problem

Forge agents and test-engineers currently cannot reliably run the same verification commands a human runs on the host. The container/project mount can have an empty or shadowed `node_modules`, so full repo tests fail for environmental reasons. That makes agent validation advisory at best and creates noise that can hide real regressions.

The FG-359/FG-374 incident exposed the gap: a test-engineer could not see the real monorepo dependency graph, then fabricated shims instead of failing. FG-375 handles the "fail, do not fake" policy. This story handles the missing capability: agents and the future Shipping Reviewer need a real dependency graph so they can run normal commands like `npm test`, `npm run typecheck`, and workspace-specific tests.

## Design Direction

Use worktrees as the safe writable project boundary:

- `/project` is an agent-specific git worktree, not the live host checkout.
- Dependencies are installed inside that disposable worktree or a container-owned dependency volume mounted at that worktree's `node_modules`.
- Agents run normal package-manager commands from the resolved project root.
- If dependencies or install state are corrupted, discard the worktree/dependency volume; do not risk the host checkout.
- Merge back only tracked source changes; never merge or commit `node_modules`.

This is why worktrees matter beyond source isolation: they make it safe for containers to have writable project-local dependency installs without corrupting the operator's live checkout.

## Goal

Make engineer, test-engineer, and Shipping Reviewer containers capable of running authoritative project verification commands against the same dependency graph shape the host repo expects.

Examples that should work inside the container from `/project`:

- `npm run typecheck`
- `npm test`
- `npm --workspace=dashboard test`

## Acceptance Criteria

- In worktree mode, an agent container has usable project dependencies from the resolved project root.
- For a monorepo/workspace project, dependency installation happens from the repo root so workspace links and `@forge/*` aliases resolve correctly.
- The dependency install is container/worktree-owned, not a read-write bind mount of the host checkout's `node_modules`.
- The design avoids committing or merging `node_modules`; cleanup removes or reuses dependency volumes safely.
- Lockfile/package-manager changes invalidate or refresh the dependency install instead of silently reusing stale dependencies.
- Missing or failed dependency provisioning produces a clear `verification_environment_unavailable`-style failure before tests are interpreted.
- Engineer/test-engineer containers can run the repo's normal test/typecheck commands without fake package shims or source stubs.
- The Shipping Reviewer container can run required host-equivalent verification commands before approving `shipped/done`.
- Post-merge host/orchestrator verification remains the final shipping gate; container verification does not replace the merged-result host gate.

## Non-Goals

- Do not bind-mount host `node_modules` read-write into containers.
- Do not allow agents to repair missing dependencies by inventing package shims or fake source modules; that is FG-375's policy boundary.
- Do not make the first worktree cut depend on perfect cross-platform dependency caching if a simpler macOS-first install path is enough to unblock real verification.

## Relations

- FG-345 / FG-351: worktree isolation provides the disposable writable project boundary this depends on.
- FG-357: post-merge integration gate should run against the merged result after worktree merges.
- FG-358: Linux-specific node_modules provisioning remains relevant, but this story is the broader all-agent verification capability.
- FG-372: Shipping Reviewer depends on real dependency parity to run required verification.
- FG-375: anti-shim policy prevents fake validation when dependency parity is absent or broken.
