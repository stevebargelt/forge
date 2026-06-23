---
id: FG-345
type: story
status: active
title: "git worktrees for ALL agents (parent design story): OS-level write isolation + reconcile/merge — needs architecture pass before implementation"
created: 2026-06-22
---

### git worktrees for ALL agents (PARENT DESIGN STORY): OS-level write isolation + reconcile/merge

(story/active — NOT implementation-ready; needs an architecture pass first. This is a decision record + design brief, not a single implementable story. It is epic-sized: it touches spawn, invoke, runNext, persistence-check, task/run state, red review semantics, merge-conflict failure states, cleanup, and integration validation.)

**DECISION (settled — do not relitigate): forge uses a dedicated git worktree per agent. Always. All agent classes.** Decided in conversation after the dogfood research run `run-always-use-git-worktrees-c31675` (report at `research/always-use-git-worktrees-s-c31675.md`). A prior handoff narrowed this to "rw/blue only" — that narrowing is WRONG. The decision is "worktrees, period." This story is about HOW, not WHETHER — and the HOW is large enough that it must go to architecture/planning and be split into implementation children before any engineer touches it.

## Why "always, all agents" (not just blue fan-out)

1. **Silent lost-updates are unacceptably costly.** Concurrent rw/blue fan-out shares ONE working dir (all blue containers get `projectMode: rw` against the same `PROJECT_DIR`; `dispatchFanoutStep` runs up to 4 concurrent containers on the identical host path). Collisions are NOT recoverable merge conflicts — they are last-writer-wins filesystem races: torn/partial writes, silent clobbers, no detection. Worktrees CONVERT these silent races into detectable `git merge` conflicts.
2. **Uniformity is simpler than a split.** One mount model for every agent beats maintaining "worktree for blue, live-mount for red/narrative."
3. **forge-on-forge host protection + consistent review snapshots.** Worktrees keep EVERY agent container off the live host source, and a red reviewing a stable snapshot beats reviewing a still-mutating `/project`.

This brings blue write-isolation up to the OS-enforced standard forge already mandates for reds (today it is nothing but an honor-system file-independence contract).

## Cost is a non-factor (do not relitigate)

~222ms / ~12MB per `git worktree add` on this repo (762 files; git objects shared). Creation lands in the `Promise.all` dispatch wave so concurrent wall-clock is ~one add, not 4×. grpcfuse is not a new tax; node_modules is already container-local ext4 (DEC-019). Caveat: a 50k-file monorepo needs a one-off checkout benchmark before promising "free" there.

## HARD DESIGN CONSTRAINTS (these are the real design pivots — the architecture pass must answer each)

1. **Worktrees catch same-file TEXTUAL races only; semantic cross-file breakage merges CLEAN.** Agent A changes a signature in `foo.ts`; agent B (own worktree) calls the old signature in `bar.ts` → `git merge` succeeds with ZERO conflict → broken code merged with no signal. **Therefore worktrees are NECESSARY BUT NOT SUFFICIENT: the design MUST include a post-merge integration gate (build + test the MERGED result).** The trap: believing worktrees make parallel work safe. They relocate the risk, not remove it.
2. **Most forge work is SEQUENTIAL; naive worktrees add a merge step to a path that cannot collide.** A pipeline runs architect → tech-lead → engineer → test-engineer in series; each sees the prior step today because it is just there on `/project`. If every step branches off `HEAD`, the engineer can't see the tech-lead's work, forcing 3-way merges between steps that never conflicted. **Required: chain each step's worktree off the PREVIOUS step's branch (fast-forward), not all-off-HEAD.**
3. **The reconcile/merge step is genuine net-new orchestrator complexity.** New "agent succeeded but reconcile failed" failure state, conflict-resolution ownership, persistence-check rework, lockfile / node_modules merge questions. Runtime cost nil; design cost real.
4. **Worktrees make real container-side dependency installs safe.** A disposable agent worktree can have its own `node_modules` install or dependency volume, letting engineers/test-engineers/reviewers run normal `npm test` / typecheck commands without corrupting the live host checkout. This is not solved by worktrees alone because `node_modules` is ignored by git, but worktrees are the safe writable boundary that makes dependency parity feasible. See FG-376.

## OPEN QUESTIONS THE ARCHITECTURE PASS MUST RESOLVE (each is a kickoff blocker)

- **Non-git projects.** Forge runs across arbitrary projects. If `/project` is NOT a git repo, what happens? Fail loud / fall back to current shared-mount behavior / `git init` a temp copy / require git for worktree mode. Must be explicit — silence here breaks cross-project use.
- **Untracked & ignored files (likely the biggest practical adoption risk).** `git worktree add` carries ONLY committed tracked content. `.env`, generated local config, design files, test fixtures, local-only assets, build caches — none come along. Define the contract: copy-in which classes? symlink? require committed? This is the most likely real-world breakage.
- **Dirty tracked state.** `git worktree add` deterministically EXCLUDES uncommitted host changes. For forge-on-forge (repo being developed IS the mounted project): commit/stash first, error on dirty, or carry the diff in.
- **Sequential-chaining state model.** "Branch off the previous step" is right, but WHERE is that branch/ref recorded — DB? run metadata? task result? task manifest? Without a concrete home, retry/cancel/reconcile get messy. (Relates to the reconcile subsystem in `src/v2/`.)
- **Red review timing.** Does a red review (a) the isolated candidate worktree pre-merge, (b) the merged phase result post-reconcile, or (c) both? A red on one child snapshot misses integration breakage; a red on merged output needs reconcile to run first. Resolve per phase type.
- **Reconcile failure states + cleanup.** New status/transition semantics when a merge conflicts; worktree teardown on success, failure, and orphan-recovery (interacts with the existing reconcile/orphan path).
- **persistence-check adaptation.** It currently asserts `files_modified` landed under the project bind mount; with worktrees that invariant moves to the worktree path.
- **Where the post-merge integration gate lives.** Almost certainly its OWN implementation story — wiring build+test of the merged result is separable from "create worktrees and merge them," and folding it into the first cut makes that cut too risky.

## Proposed child-story split (to be CONFIRMED/redrawn by the architecture pass — do not pre-file blindly)

1. **Worktree architecture plan / ADR** (this is the immediate next step — architecture-advisor).
2. per-task worktree lifecycle + manifest/DB state (create-before-dispatch, remove-after-exit, ref recording).
3. reconcile/merge primitive (single-branch merge-back + conflict surfacing).
4. fan-out merge ordering + conflict handling.
5. persistence-check adaptation.
6. red snapshot semantics.
7. post-merge integration gate (build+test merged result) — likely standalone.

## Implementation surface (for scoping only — not a plan)

`spawn.ts` (PROJECT_DIR → worktree path), `invoke.ts`/`runNext.ts` (worktree lifecycle), persistence-check subsystem, dependency provisioning for real container-side test runs (FG-376), the new reconcile/merge step, the integration gate. Relates: DEC-004 (orchestrator-on-host/agents-in-containers), DEC-019 (node_modules shadow volume), the red read-only mount principle, the existing `src/v2/` reconcile/orphan path.
