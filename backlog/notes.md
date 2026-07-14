**Last session ended 2026-07-13.**

**Where we left off:** Ran the queue FG-425 → FG-548 → FG-355 → FG-356. **Stopped after FG-548 on operator instruction — FG-356 was NOT started.** Three tickets closed (FG-425, FG-548, FG-355); FG-355 closed with NO code (FG-425 already satisfied it). Two follow-ups filed (FG-550, FG-551).

**Picked up next:**
1. **FG-356 — orphan worktree cleanup. NOT STARTED. Its ticket body is now STALE and must be re-scoped BEFORE implementing.** FG-425 changed its shape: the publisher creates a FRESH PER-ATTEMPT integration worktree (AD-4: never pooled, never reused after a crash or a moved-base rebuild), so worktrees now accumulate per publication ATTEMPT, not just per task. The FG-425 architect explicitly flagged that AD-4 silently breaks FG-356's DB-row-driven cleanup model, and FG-425 deliberately left a DISCOVERABLE HANDLE on the durable publication-attempt record (src/store/publications.ts) for FG-356 to reclaim them. FG-356 must sweep BOTH task worktrees AND publisher per-attempt worktrees, discovered from durable rows — never by filesystem scanning. Preserve its invariants: retain merge_conflict worktrees for inspection; idempotent across repeated reconciles. AD-4 also says cleanup is NEVER a correctness prerequisite for publication — FG-356 is GC, not a gate.
2. **FG-551** — agent-dev-worker image lacks tmux, so the FG-535 launch-cli tests hard-fail 10x in EVERY agent container. Not a code defect (CI has tmux; both checks green) — but it makes every agent's suite look red and it cost real time this session diagnosing it twice.
3. **FG-541** — review-loop's fixer commits but never pushes, so the loop can NEVER report closeable on its own after a fix round; it always stops at local_only and needs an orchestrator push + re-run. This burned 2 of the 3 permitted FG-425 loop invocations on a purely mechanical condition.

**External state:**
- Branch fix/fg425-project-gate-locking (ce22024): still DELIBERATELY UNMERGED AND ABANDONED. FG-425 shipped the replacement; the ADR (learnings/decisions/serialized-integration-publisher.md) explicitly supersedes it. Do not merge, do not delete.
- Branch fg540-recover-schema-validation-evidence: still deliberately unmerged.
- FG-425 added a `publications` table to the host-global DB (additive, forward-only; migration has run cleanly).
- forge ops check still reports the 12 orphaned_work_may_persist false positives — that is FG-549, unfixed. Ignore them.

**Decisions worth not relitigating:**
- **The lane ORDERS; the mutex + CAS + ancestry proof + candidateSha binding make publication CORRECT.** A wrongly-skipped lane entry costs fairness, never a wrong publication. This layering is WHY no process supervision is needed (AD-7) and is stated in the ADR. A reader who misses it will "harden" the lane by reintroducing PID probes — do not.
- **The lane turn SPANS validation. Only the MUTEX is short.** Two separate reds raised "the lane contradicts the short-publication-window constraint"; both were WRONG. AD-2 explicitly orders candidate integration, final validation, AND publication. Moving validation outside the turn would let two forge attempts churn each other's base. Rejected twice — do not accept it a third time.
- **--force-with-lease constrains the BASE, not the SHAPE.** It carries force semantics and WILL push a non-fast-forward candidate once its CAS matches. The fast-forward ancestry proof is independently load-bearing. Neither guard may be dropped as implied by the other.
- **FG-355 is done, without code.** Reds review the candidate at candidateSha — byte-for-byte the commit that publishes — which is STRONGER than the ticket's original "mount the primary's worktree" (a branch tree, not necessarily what ships). Do not implement the superseded mechanic.
- Invariant 13 in docs/invariants.md was WRONG on first landing and was corrected by the review loop: a crash mid-publish does NOT always mean nothing was published. An already-CAS-published validated candidate is DURABLE and recovery COMPLETES its checkout rather than undoing it. An operator who believes otherwise will hand-roll a destructive rollback.

**Process lessons:**
- **Prove a concurrency test can fail.** FG-548's regression was verified by FALSIFICATION on the host: reverting runs.ts to the deferred form reproduced SQLITE_BUSY 3x in 200 iterations; the fixed form was clean at 600. A green stress loop that cannot go red is worth nothing.
- **The documentation-maintainer found the two best bugs of the session** — both in CODE it was not allowed to edit (the `git reset --hard` data-loss trap; and four failure kinds missing from a Record<string,...> POLICY table, which therefore did not fail typecheck). Read its stale_docs_found carefully; it is not just docs.
- `forge next` FINALIZES a wave and returns success WITHOUT dispatching the next phase. It needs a second call. Easy to mistake for a stalled run.

**Shipped:** FG-425 (PR #114 / 4762b1f) — serialized integration publisher, 39 files, ~6.6k lines; also fixed a latent process-killing crash on main (docker-exec unhandled 'error' over a log file). FG-548 (PR #115 / 5bb675b) — BEGIN IMMEDIATE by construction + repo-wide guard. FG-355 (4762b1f, no code). Backlog: 6b5e5a3, d1306bd.
