**Last session ended 2026-07-07.**

**Where we left off:** Shipped FG-479 end-to-end autonomously (PR #53, merged as de566fd) — the CRITICAL F1 finding from the 2026-07-06 engineering review (notes/forge-engineering-review-2026-07-06.md): reconcile falsely completed crashed PIPELINE tasks from container-gone recovery, bypassing reds/integration gate/human gates/worktree merge-back. Clean stopping point; main is green (typecheck + full test:all + review-loop pass).

**Picked up next:**
1. **The review file has F2-F20 unfiled.** F1 is done (FG-479); F2 is FG-476 (already shipped) + a drive-loop bound (NOT yet filed); F3 (blocked_by_red non-atomic write) and F4 (campaign quick-lane frontmatter ship) are the remaining CRITICAL/HIGH trust items — file tickets from the review's "Backlog Recommendations" section before they go stale.
2. **FG-478** (active) — on_reject → fanout-step recovery semantics. Needs architecture pass; route implementation_full.
3. **FG-477** (active) — lifecycle evaluator (root-cause consolidation). The review endorses it with three shaping constraints (pure derivation, fold verdict aggregation in, task-lineage classifier first slice) — read section 4/“On FG-477” before starting.
4. **FG-481** (active, new) — decide whether forge recover --continue on a PIPELINE task needs the FG-479 no-complete-without-finalize guard (operator-explicit sibling of the closed silent path). Small, decision-first.
5. **FG-480** (active, new) — cosmetic: fanoutWaveRecoveryMessage all-children-complete wording. Batchable low.

**What FG-479 shipped (PR #53, 5 commits):** isInvokeRun guard on both container-gone completion branches (valid result + stdout-recovered); new failure_kind orphaned_needs_finalize (result preserved on row+disk, retry --force re-drive, recover --continue refuses, own ops-check incident kind that a CLEAN worktree does not suppress, forge show recovery headline + Next-action arm); fanout-parent recovery extended the same rule (all-complete waves land failed/fanout_wave_unfinalized, re-drivable — a REVIEW-round extension, behavior change documented in docs/concepts.md); docs/concepts.md reconciled twice by documentation-maintainer.

**Process learnings this session (also in memory):**
- review-loop wrapper Bash tasks got externally stopped twice; the loop runs deterministic verification (~8 min, silent) BEFORE creating the reviewer run — a quiet startup is normal, don't kill it. Detached containers survive wrapper death; a killed round's fixer work lands UNCOMMITTED in the tree — inspect git status before assuming loss.
- Do NOT file backlog tickets while a review-loop is in flight: the out-of-scope tree restore DELETED the untracked FG-480 ticket file and the allocator reused the number (recover-continue ticket is now FG-481; PR #53 body corrected, commit efa0d9b's "FG-480" reference is stale — refers to FG-481).
- Engineering-review F1 fix pattern that worked: orchestrator implements directly on a branch → documentation-maintainer per docs-impact → review-loop (fix findings, rerun to pass) → merge on FG-436 authorization (closeable + test:all + no required CI) → close with AC walk.

**Decisions worth not relitigating:**
- orphaned_needs_finalize deliberately reuses existing statuses (failed + failure_kind) — NO new tasks.status value (schema/ADR rule respected). Real re-drive-through-finalize machinery is FG-477 territory, not retrofitted here.
- Fanout all-complete parents now NEVER complete via reconcile (trust-first; re-drive redoes the whole wave). Accepted cost: an all-complete orphaned wave needs an operator --re-drive.
