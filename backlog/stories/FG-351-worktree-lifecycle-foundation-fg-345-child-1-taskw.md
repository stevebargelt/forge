---
id: FG-351
type: story
status: active
title: "Worktree lifecycle foundation (FG-345 child 1): Task.worktreePath, create/remove, platform/non-git/dirty gates, branch naming, PROJECT_DIR substitution"
created: 2026-06-22
---

**Parent:** FG-345 (worktrees for all agents). **First child — foundation; everything else depends on this.** **No dependency.**

Establish the per-task worktree primitive and the guardrails, without any merge-back yet (merge is FG-352). This story must not make default production runs write only to a disposable worktree and then clean it up before merge-back exists. Land this behind an explicit worktree-mode gate until FG-352 (merge) and FG-354 (persistence-check adaptation) make the path safe, or keep the primitive dormant/test-only. Sequence tightly with FG-352 and FG-354 so a worktree run cannot silently discard successful agent output or be falsely flagged un-persisted.

## Scope
- **Task durable state.** `worktreePath` on the Task row (`src/types/index.ts` + store schema), plus durable task branch identity (field or deterministic derivation documented in code/tests). Set BEFORE `runContainer`; survives process restarts (reconcile runs in a separate forge invocation). This is the state that threads through the four call sites (primary mount, red mount, persistence-check, reconcile cleanup) and the later merge primitive.
- **Resolved repo root.** Create worktrees from the resolved git repository root, not the shell cwd and not a project subdirectory. This must respect the FG-374 project-root preflight behavior.
- **Create / remove lifecycle.** Worktrees live under `join(FORGE_HOME, 'worktrees', runId, taskId)` (src/util/paths.ts) — always within Docker Desktop's macOS file-sharing allowlist. Create before dispatch. Cleanup must never remove the only copy of unmerged task output; success cleanup is allowed only for paths that are provably merged, unchanged, or explicitly test/dormant mode.
- **PROJECT_DIR substitution.** Inject the worktree path into `ctx.PROJECT_DIR` (spawn.ts:171 is the single mount-resolution match point). No other spawn.ts changes; shadow-volume trigger (spawn.ts:247-259) stays correct.
- **Branch naming (DECIDED):** named branch per task `forge/<run-id>/<task-id>`. Delete on successful merge/cleanup; **retain on merge conflict** for inspection (retain-on-conflict is enforced in FG-352, but naming is defined here).
- **Platform gate (DECIDED):** macOS only. **Hard-fail on Linux** with a clear message unless `FORGE_NO_WORKTREES=1`. Do not silently run a known-broken Linux path (node_modules gap → confusing agent failures). Linux support is FG-358.
- **Non-git gate (DECIDED):** if `/project` is not a git repo, **fail loud**. Global `FORGE_NO_WORKTREES=1` reverts to today's shared bind-mount. No per-run flag.
- **Dirty-state gate (DECIDED):** if `run.projectDir` has uncommitted tracked changes at worktree-create time, **hard error** with a commit/stash message. Expert escape hatch `FORGE_WORKTREE_IGNORE_DIRTY=1`. (Dirty → worktree is stale by construction, breaking the "what did the agent see" guarantee.)
- **Untracked/ignored-file diagnostic.** Do not solve copy-in/symlink policy here, but make the limitation visible: git worktrees include committed/tracked content only. If local untracked/ignored files are present, report that they will not be present in the agent worktree or record an equivalent diagnostic that the operator/dashboard can surface.

## Acceptance
- Task rows persist `worktreePath` and task branch identity before container dispatch; both are readable after process restart.
- Worktree paths are created under `FORGE_HOME/worktrees/<runId>/<taskId>` from the resolved git repository root, not the shell cwd or a project subdirectory.
- Worktree branches use `forge/<run-id>/<task-id>` and are deterministic from task/run metadata.
- Worktree mode is behind an explicit gate until FG-352 and FG-354 make merge-back and persistence checks safe; default production behavior must not discard successful agent changes.
- On macOS with worktree mode enabled, a dispatched agent container sees `/project` as the task worktree, not the live checkout.
- Linux hosts hard-fail unless `FORGE_NO_WORKTREES=1`.
- Non-git projects hard-fail unless `FORGE_NO_WORKTREES=1`.
- Dirty tracked state hard-fails unless `FORGE_WORKTREE_IGNORE_DIRTY=1`.
- Worktree creation reports that untracked/ignored host files are not included, or records this limitation in a visible diagnostic.
- Cleanup removes worktrees/branches only when doing so cannot discard unmerged task output; failed, unfinished, conflict-ready, or unmerged cases retain enough state for inspection/reconcile.
- Reconcile/cleanup can find stale worktrees from persisted task state after restart.
- Tests cover macOS happy path, Linux gate, non-git gate, dirty-state gate, project-root resolution, persisted task state, and cleanup behavior.
- Verification: host `npm run typecheck`, host `npm test`, plus targeted worktree lifecycle tests pass.

Refs: spawn.ts:171/247-259, src/util/paths.ts:5, src/types/index.ts, src/v2/runNext.ts:363.
