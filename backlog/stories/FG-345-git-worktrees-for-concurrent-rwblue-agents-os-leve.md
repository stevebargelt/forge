---
id: FG-345
type: story
status: active
title: "git worktrees for concurrent rw/blue agents: OS-level write isolation (parity with reds), with a reconcile/merge step"
created: 2026-06-22
---

**Origin:** dogfood research-synthesis run `run-always-use-git-worktrees-c31675` (report at `research/always-use-git-worktrees-s-c31675.md`), then sharpened in conversation. The research's framing over-indexed on cost; the real driver is a write-isolation gap. This ticket captures the corrected framing.

## The actual problem (named precisely)

Concurrent rw/blue agents share ONE working directory: all blue/implementer containers get `projectMode: rw` against the same `PROJECT_DIR`, and `dispatchFanoutStep` runs up to 4 concurrent containers on the identical host path (runNext.ts fanout; spawn.ts mount construction). The feature pipeline dispatches frontend/backend/security/platform specialists concurrently against overlapping project areas.

This is NOT "merge conflicts." A merge conflict is detected and recoverable — git is the referee and nothing is lost. What the shared mount produces is the opposite: **silent lost-updates and torn/partial writes from a filesystem race** — last-writer-wins with no detection, no record, no resolution. For shared mutable files (lockfiles, migration sequences, generated code, `node_modules` during concurrent install) it is straight corruption you discover later. Strictly worse than a merge conflict, because a merge conflict at least tells you.

The ONLY thing preventing this today is a **prompt-level** contract — the feature workflow's file-independence rule (each agent told to touch only its plan-step's file list). That is honor-system, not enforcement, and it cannot cover genuinely shared files.

## Why this violates forge's own principle

Forge already holds the line that isolation must be OS-level, never a prompt instruction: red agents get OS-enforced read-only mounts precisely because "never relax it to a prompt instruction." Blue-agent WRITE isolation is currently nothing but the honor system. Worktrees bring blue isolation up to the **same OS-enforced standard forge already mandates for reds** — this is internal-consistency with a stated principle, not a cost/benefit tradeoff.

## Cost is explicitly ruled out (do not relitigate)

Measured on this repo: `git worktree add` ~222ms, ~12MB checkout (762 files; git objects shared, not copied). The research's "~880ms/batch" was a serial-summing error — worktree creation lands in the `Promise.all` dispatch wave, so concurrent wall-clock is ~one worktree-add (~222–400ms incl. git's brief index lock), not 4×. grpcfuse is NOT a new tax (the shared mount already uses it; the highest-write path `node_modules` is already container-local ext4 via the DEC-019 shadow volume). Caveat retained: checkout time/disk scale with working-tree file count, so a 50k-file monorepo needs a one-off benchmark before promising "free" there. For forge-scale: cost is negligible. The decision is about correctness, not cost.

## The value, stated precisely

Worktrees don't make collisions disappear — they **convert silent races into detectable, recoverable merge conflicts.** Each blue agent works in its own worktree/branch; reconciliation afterward surfaces any real collision as a proper `git merge` conflict (the good, visible kind) instead of a silent clobber. Usually the file-independence contract gives disjoint file sets and the merge is clean; worktrees are the safety net for when the contract is violated or touches shared files.

## The central design question (ahead of all others)

Isolating agents into worktrees introduces a **reconcile/merge step forge does not have today** — currently agents write straight to `/project` and that IS the output (persistence-check validates `files_modified` landed under the bind mount). With worktrees, branches must be merged back, and that merge is where conflicts now surface. The merge strategy is the core of this design: who merges, when, conflict handling, and how persistence-check adapts (it currently asserts writes land under the project bind mount, not a worktree).

## Secondary design questions

- **Dirty-state policy:** `git worktree add` deterministically EXCLUDES uncommitted host changes. For forge-on-forge (the repo being developed IS the mounted project) and any flow needing in-progress edits visible, define the contract: commit/stash first, error on dirty, or explicitly carry the diff in. (Note: worktrees would REDUCE the live-code-mutation hazard for forge-on-forge while adding a stale-state risk.)
- **Red's view:** does a red review the blue's worktree (a consistent snapshot of exactly what that agent produced — arguably better than today) or the live project? A real choice, not a footnote.

## Scope

The surface is specifically concurrent **rw/blue build fan-out** (feature pipeline specialists). Narrative fan-out (research-synthesis roles) does NOT write `/project`; reds are already OS-isolated. "Always" (every agent its own worktree) is viable since cost is negligible and uniform is simpler — but reds-on-live-mount may be deliberately retained (see red's-view question). Decide blue-only-rw-fanout vs truly-always as part of the design.

## Implementation surface (from the research, for scoping only — not a plan)

`spawn.ts` (PROJECT_DIR substitution → worktree path), `invoke.ts`/`runNext.ts` (worktree lifecycle: create before dispatch, remove after container exit), persistence-check subsystem (currently validates `files_modified` under the project bind mount), plus the new reconcile/merge step. Relates: DEC-004 (orchestrator-on-host/agents-in-containers), DEC-019 (node_modules shadow volume), the red read-only mount principle.
