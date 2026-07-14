**Last session ended 2026-07-13.**

**Where we left off:** Ran the autonomous queue FG-425 → FG-548 → FG-355 → FG-356. **Stopped after FG-548 on explicit operator instruction — FG-356 was never started.** FG-355 closed with NO code (FG-425 already satisfied it, more strongly than its own ticket specified). The session's closing question was FG-396 readiness; the answer recorded below is **not ready**, and FG-356 is the reason.

**Picked up next:**

1. **FG-356 — orphan worktree cleanup. NOT STARTED, and its ticket body is now STALE. Re-scope it BEFORE writing code.** FG-425 enlarged it: the publisher creates a FRESH PER-ATTEMPT integration worktree (AD-4 — never pooled, never reused after a crash or a moved-base rebuild), so worktrees now accumulate per publication ATTEMPT, not just per task. The FG-425 architect explicitly flagged that AD-4 silently breaks FG-356's DB-row-driven cleanup model, and FG-425 deliberately left a **discoverable handle on the durable publication-attempt record** (`src/store/publications.ts`) for FG-356 to reclaim them. So FG-356 must sweep BOTH task worktrees AND publisher per-attempt worktrees, discovered from durable rows — never by filesystem scanning. Preserve its existing invariants: retain `merge_conflict` worktrees for inspection, idempotent across repeated reconciles. Note AD-4 also says cleanup is NEVER a correctness prerequisite for publication — FG-356 is GC, not a gate.

2. **FG-551 — agent-dev-worker image lacks tmux.** The FG-535 launch-cli tests hard-fail 10x in EVERY agent container. Not a code defect (CI has tmux; both required checks are green), but it makes every agent's suite look red, and it cost real diagnosis time twice this session. Small, high-leverage, unblocks clean agent test reporting.

3. **FG-541 — review-loop's fixer commits but never pushes.** The loop therefore can NEVER report `closeable` on its own after a fix round: it always stops at `local_only` and needs an orchestrator push + re-run. This burned 2 of the 3 permitted FG-425 loop invocations on a purely mechanical condition. Fixing it makes the loop's verdict self-sufficient.

4. **FG-549 — `ops check` false positives.** Still reporting 12 permanent `orphaned_work_may_persist` incidents on this project. All noise (shared project dir, tree clean, nothing stranded). Ignore them until this lands.

**External state to remember:**
- Branch `fix/fg425-project-gate-locking` (`ce22024`): still **DELIBERATELY UNMERGED AND ABANDONED**. FG-425 shipped the replacement design and the ADR (`learnings/decisions/serialized-integration-publisher.md`) explicitly supersedes it. Do not merge, do not delete.
- Branch `fg540-recover-schema-validation-evidence`: still deliberately unmerged.
- FG-425 added a `publications` table to the **host-global** `~/.forge/forge.db`. Additive and forward-only; the migration has run cleanly. A pre-change backup was taken to the session scratchpad.

**Decisions worth not relitigating:**
- **The lane ORDERS; the mutex + CAS + fast-forward ancestry proof + `candidateSha` binding make publication CORRECT.** A wrongly-skipped lane entry costs fairness, never a wrong publication. This layering is *why* no process supervision is needed (AD-7), and the ADR states it. A reader who misses it will "harden" the lane by reintroducing PID probes — do not.
- **The lane turn SPANS validation; only the MUTEX is short.** Two separate reds claimed the lane "contradicts the short-publication-window constraint." Both were WRONG — AD-2 explicitly orders candidate integration, final validation, AND publication. Moving validation outside the turn would let two forge attempts churn each other's base. Rejected twice; do not accept it a third time.
- **`--force-with-lease` constrains the BASE, not the SHAPE.** It carries force semantics and WILL push a non-fast-forward candidate once its CAS matches. The fast-forward ancestry proof is independently load-bearing. Neither guard may be dropped as implied by the other.
- **FG-355 is done, without code.** Reds review the candidate at `candidateSha` — byte-for-byte the commit that publishes — which is STRONGER than the ticket's original "mount the primary's worktree" (a branch tree, not necessarily what ships). Do not implement the superseded mechanic.
- **Invariant 13 in `docs/invariants.md` was WRONG on first landing** and was corrected by the review loop. A crash mid-publish does NOT always mean nothing was published: an already-CAS-published validated candidate is DURABLE, and recovery COMPLETES its checkout rather than undoing it. An operator who believes otherwise will hand-roll a destructive rollback.
- **FG-396 is NOT ready** (this session's closing question). FG-425 cleared its named integration-lock blocker, but both engineering reviews are explicit that parallelism must not land before project-scoped integration ownership is complete — and the GC half (FG-356) is unstarted. Shipping parallel lanes on an unbounded per-attempt worktree leak would turn a known GC gap into an operational one. Land re-scoped FG-356 first, then open a fresh FG-396 architecture pass.

**Process lessons worth keeping:**
- **Prove a concurrency test can fail.** FG-548's regression was verified by FALSIFICATION on the host: reverting `runs.ts` to the deferred form reproduced SQLITE_BUSY 3x in 200 iterations; the fixed form was clean at 600. A green stress loop that cannot go red is worth nothing.
- **The documentation-maintainer found the two best bugs of the session — both in CODE it was not allowed to edit** (a `git reset --hard` data-loss trap; and four failure kinds missing from a `Record<string, ...>` POLICY table, which therefore did not fail typecheck). Read its `stale_docs_found` carefully; it is not just about docs.
- **`forge next` FINALIZES a wave and returns success WITHOUT dispatching the next phase.** It needs a second call. Easy to mistake for a stalled run.

**Shipped (for reference):**
- **FG-425** (PR #114 / `4762b1f`) — serialized integration publisher. Validation runs against a candidate in a per-attempt worktree; the exact recorded SHA publishes through a short CAS window. All four merge-then-gate-the-target sites converged, so a red that rejects the candidate publishes nothing. ~39 files. Also fixed a latent process-killing crash on main (`docker-exec` unhandled `'error'` over a log file) and a `git reset --hard` retry-advice data-loss trap.
- **FG-548** (PR #115 / `5bb675b`) — `BEGIN IMMEDIATE` for every multi-process-reachable write txn, by construction (`writeTransaction()`) + a repo-wide guard with a negative test proving the guard fires.
- **FG-355** (`4762b1f`, no code) — closed on evidence; FG-425 already satisfied its invariant.
- Filed: **FG-551** (agent image lacks tmux), **FG-550** (carried).
