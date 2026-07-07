**Last session ended 2026-07-07.**

**Where we left off:** FG-479 shipped and closed (PR #53, de566fd), plus a follow-up wording PR #54 (ec436e4): all operator retry guidance now names the task id (reconcile/ops errors interpolate it; retryPolicy() substitutes the <id> placeholder when callers pass taskId). Both landed via the direct-implement -> docs-maintainer -> review-loop -> FG-436 merge pattern; main is green. **Operator explicitly stopped work before FG-481 to queue an overnight batch — do NOT start FG-481 or anything else until that queue is defined.**

**Picked up next:**
1. **Define the overnight queue with the operator.** Candidate pool offered: review findings F3 (atomic markTaskBlockedByRed), F4 (campaign quick-lane ship needs host-verification gate), F5 (finalizeRunIfSettled + abandoned->complete store CAS), F2b (driveWorkflowItem no-progress bound), F6/F7 (campaign transient-retry verb + catch-and-park), F9 (failure notifications); plus filed FG-481, FG-435, FG-451, FG-378. Note: campaigns are NOT ready as the unattended surface until F2b/F6/F7 land (review section 3) — either run the batch per-ticket (FG-479 pattern) or make campaign-hardening the batch.
2. **FG-481** (active) — recover --continue pipeline adoption decision. Decision-first, small. Queued by operator, deliberately not started.
3. **FG-478 / FG-477** — unchanged from before; FG-477 wants the review's three shaping constraints (pure derivation, fold verdict aggregation, lineage classifier first).
4. **File tickets for the review's F2-F20 recommendations** before they go stale (notes/forge-engineering-review-2026-07-06.md section 4) — only F1 (FG-479) is done.

**FG-480 was filed in error and closed by the operator** (cosmetic fanoutWaveRecoveryMessage wording — noise-level, not worth tracking). Don't refile it, and don't file similar noise-caliber cosmetic tickets; the review-loop's pass-level design nit on retry-policy <id> substitution (no test forcing callers to thread taskId) was deliberately left untracked for the same reason.

**Process learnings this session (also in memory):**
- review-loop runs ~8 min of silent deterministic verification BEFORE creating the reviewer run — a quiet startup is normal. Detached containers survive wrapper death; a killed round's fixer work lands UNCOMMITTED — check git status before assuming loss.
- Do NOT file backlog tickets while a review-loop is in flight: the out-of-scope tree restore deletes untracked ticket files and the allocator reuses the number (that's why recover-continue is FG-481; PR #53/commit efa0d9b's "FG-480" references are stale and mean FG-481).
- The operator's other forge session shares this working tree — expect its uncommitted backlog state; park it (labeled stash) during review-loops, restore + commit it after, never sweep it into unrelated commits.

**Decisions worth not relitigating:**
- orphaned_needs_finalize reuses failed+failure_kind, NO new tasks.status. Real re-drive-through-finalize is FG-477 territory.
- Fanout all-complete parents never complete via reconcile (fanout_wave_unfinalized, re-drive redoes the wave) — accepted cost, documented in concepts.md.
