---
id: FG-351
type: story
status: active
title: "Worktree lifecycle foundation (FG-345 child 1): Task.worktreePath, create/remove, platform/non-git/dirty gates, branch naming, PROJECT_DIR substitution"
created: 2026-06-22
---

**Parent:** FG-345 (worktrees for all agents). **First child — foundation; everything else depends on this.** **No dependency.**

Establish the per-task worktree primitive and the guardrails, without any merge-back yet (merge is FG-352). After this story, agents RUN in worktrees but their output is not yet merged to main — so land this behind a gate / behind the merge story before it changes default behavior, OR scope it so the worktree is created and the agent writes there but the existing persistence/merge path is adapted in the immediately-following stories. Sequence with FG-354 (persistence-check) so a worktree run isn't falsely flagged un-persisted.

## Scope
- **`worktreePath` on the Task row** (`src/types/index.ts` + store schema). Set BEFORE `runContainer`; survives process restarts (reconcile runs in a separate forge invocation). This is the field that threads through the four call sites (primary mount, red mount, persistence-check, reconcile cleanup).
- **Create / remove lifecycle.** Worktrees live under `join(FORGE_HOME, 'worktrees', runId, taskId)` (src/util/paths.ts) — always within Docker Desktop's macOS file-sharing allowlist. Create before dispatch, remove after the task's terminal transition.
- **PROJECT_DIR substitution.** Inject the worktree path into `ctx.PROJECT_DIR` (spawn.ts:171 is the single mount-resolution match point). No other spawn.ts changes; shadow-volume trigger (spawn.ts:247-259) stays correct.
- **Branch naming (DECIDED):** named branch per task `forge/<run-id>/<task-id>`. Delete on successful merge/cleanup; **retain on merge conflict** for inspection (retain-on-conflict is enforced in FG-352, but naming is defined here).
- **Platform gate (DECIDED):** macOS only. **Hard-fail on Linux** with a clear message unless `FORGE_NO_WORKTREES=1`. Do not silently run a known-broken Linux path (node_modules gap → confusing agent failures). Linux support is FG-358.
- **Non-git gate (DECIDED):** if `/project` is not a git repo, **fail loud**. Global `FORGE_NO_WORKTREES=1` reverts to today's shared bind-mount. No per-run flag.
- **Dirty-state gate (DECIDED):** if `run.projectDir` has uncommitted tracked changes at worktree-create time, **hard error** with a commit/stash message. Expert escape hatch `FORGE_WORKTREE_IGNORE_DIRTY=1`. (Dirty → worktree is stale by construction, breaking the "what did the agent see" guarantee.)

## Acceptance
- Task row carries `worktreePath`; populated before container start; readable after restart.
- macOS rw agent runs against a worktree at the FORGE_HOME path; container sees its contents.
- Linux host hard-fails (unless `FORGE_NO_WORKTREES=1`); non-git project hard-fails (unless flag); dirty tracked tree hard-fails (unless `FORGE_WORKTREE_IGNORE_DIRTY=1`).
- Worktree + branch are removed on clean task completion.
- forge-test green; the gates have negative-path tests.

Refs: spawn.ts:171/247-259, src/util/paths.ts:5, src/types/index.ts, src/v2/runNext.ts:363.
