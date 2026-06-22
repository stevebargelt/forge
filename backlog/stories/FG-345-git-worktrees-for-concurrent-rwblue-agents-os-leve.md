---
id: FG-345
type: story
status: active
title: "git worktrees for concurrent rw/blue agents: OS-level write isolation (parity with reds), with a reconcile/merge step"
created: 2026-06-22
---

### git worktrees for ALL agents: OS-level write isolation + consistent snapshots, with a reconcile/merge step

(story/active)

**DECISION (settled — do not relitigate): forge uses a dedicated git worktree per agent. Always. All agent classes.** Decided in conversation after the dogfood research run `run-always-use-git-worktrees-c31675` (report at `research/always-use-git-worktrees-s-c31675.md`, which asked the broad "always / each agent" question). A prior handoff narrowed this to "rw/blue only" — that narrowing is WRONG and is the reason this ticket exists in corrected form. The decision is "worktrees, period." This ticket is about HOW, not WHETHER.

## Why "always, all agents" (not just blue fan-out)

The corruption case alone settles it for rw/blue, but the decision is all-agents for three independent reasons:

1. **Silent lost-updates are unacceptably costly.** Concurrent rw/blue fan-out shares ONE working dir (all blue containers get `projectMode: rw` against the same `PROJECT_DIR`; `dispatchFanoutStep` runs up to 4 concurrent containers on the identical host path). Collisions are NOT recoverable merge conflicts — they are last-writer-wins filesystem races: torn/partial writes, silent clobbers, no detection, no record. One lost collision costs real work AND tokens to redo. Worktrees CONVERT these silent races into detectable, recoverable `git merge` conflicts.
2. **Uniformity is simpler than a split.** One mount model for every agent is less code and fewer special cases than maintaining "worktree for blue, live-mount for red/narrative." All-agents is the simpler design, not the more complex one.
3. **forge-on-forge host protection + consistent review snapshots.** Worktrees keep EVERY agent container off the live host source (the research's third lane confirms this reduces the live-code-mutation hazard). And a red reviewing a stable worktree snapshot of exactly what an agent produced is better than reviewing a still-mutating `/project`.

This also brings blue write-isolation up to the OS-enforced standard forge already mandates for reds (reds get OS read-only mounts precisely because isolation must never be a prompt instruction). Today blue write-isolation is nothing but an honor-system file-independence contract.

## Cost is a non-factor (do not relitigate)

Measured on this repo: `git worktree add` ~222ms, ~12MB checkout (762 files; git objects shared, not copied). Worktree creation lands in the `Promise.all` dispatch wave, so concurrent wall-clock is ~one worktree-add, not 4× (the research's "880ms/batch" was a serial-summing error). grpcfuse is not a new tax (shared mount already uses it; node_modules is already container-local ext4 via DEC-019). Caveat retained: a 50k-file monorepo needs a one-off checkout benchmark before promising "free" there — but for forge-scale, cost is negligible.

## HARD DESIGN CONSTRAINTS (from conversation 2026-06-22 — these are not cost arguments; they are the real design pivots and must be answered, not waved off)

These three are the genuine constraints the "cost / no collisions" framing hides. None block the decision; two get MORE important as parallel work expands, not less.

1. **Worktrees catch same-file TEXTUAL races only; semantic cross-file breakage merges CLEAN.** Agent A changes a function signature in `foo.ts`; agent B (own worktree) calls the old signature in `bar.ts`. Different files → `git merge` succeeds with ZERO conflict → broken code merged with no signal. The shared mount has this same gap, so worktrees don't make it worse — but "merge succeeded" must NOT be read as "result is correct." As fan-out widens, this semantic class grows faster than the same-file class worktrees catch. **Therefore: worktrees are NECESSARY BUT NOT SUFFICIENT. The design MUST include a post-merge integration gate — build + test the MERGED result before the fan-out is called done.** The trap to avoid: adopting worktrees and believing the parallel-safety problem is solved. It is relocated, not solved. (This integration gate may spin out as its own ticket once the architect scopes it — flag if so.)

2. **Most forge work is SEQUENTIAL; naive worktrees add a merge step to a path that cannot collide.** A feature pipeline runs architect → tech-lead → engineer → test-engineer in series; each step sees the prior step's output today because it is just there on `/project`. If every step gets a worktree off `HEAD`, the engineer cannot see the tech-lead's work, forcing 3-way merges BETWEEN sequential steps that never conflicted. **Required design choice: chain each step's worktree off the PREVIOUS step's branch (fast-forward, not merge), not all-off-HEAD.** Get this wrong and you add a reconcile-failure class to the linear path for no isolation benefit. The sequential-path win is real but smaller (snapshot + host-protection), not corruption-avoidance.

3. **The reconcile/merge step is genuine net-new orchestration complexity, and it lands on the ORCHESTRATOR.** Runtime cost is nil; design cost is not. It introduces a new "agent succeeded but reconcile failed" failure state, conflict-resolution ownership, persistence-check rework (asserts writes land under the bind mount today), and lockfile / `node_modules` merge questions under DEC-019. Worth paying — but it is the opposite of "free," and pretending otherwise ships it half-designed.

## The central design question (this is the real work)

Worktrees introduce a **reconcile/merge step forge does not have today.** Currently agents write straight to `/project` and that IS the output (persistence-check validates `files_modified` landed under the bind mount). With per-agent worktrees, branches must be merged back, and that merge is where collisions surface as proper conflicts. The merge strategy is the core of this design:
- Who merges, when (per-agent-exit? end-of-fan-out? per-phase?), and in what order.
- Conflict handling: who resolves, and what the orchestrator does when a real conflict surfaces.
- How persistence-check adapts (it currently asserts writes land under the project bind mount, not a worktree).
- How the post-merge integration gate (constraint 1) hooks in.
- Sequential branch-chaining (constraint 2): each step's worktree off the previous step's branch.

## Secondary design questions

- **Dirty-state policy:** `git worktree add` deterministically EXCLUDES uncommitted host changes. For forge-on-forge (the repo being developed IS the mounted project), define the contract: commit/stash first, error on dirty, or carry the diff in. (Worktrees REDUCE the live-mutation hazard but ADD a stale-state risk for flows needing in-progress edits visible.)
- **Red's view:** red reviews its target agent's worktree snapshot (consistent — arguably better) vs the live project. With all-agents worktrees the natural answer is the snapshot; confirm.
- **Narrative fan-out:** research-synthesis roles don't write `/project` today, so a worktree is cheap insurance, not strictly required — but uniformity says give them one anyway unless there's a concrete reason not to.

## Implementation surface (for scoping only — not a plan)

`spawn.ts` (PROJECT_DIR substitution → worktree path), `invoke.ts`/`runNext.ts` (worktree lifecycle: create before dispatch, remove after container exit), persistence-check subsystem (validates `files_modified` under the project bind mount today), plus the NEW reconcile/merge step and the post-merge integration gate. Relates: DEC-004 (orchestrator-on-host/agents-in-containers), DEC-019 (node_modules shadow volume), the red read-only mount principle.
