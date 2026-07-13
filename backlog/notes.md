**Last session ended 2026-07-13 (FG-425 architecture correction + decisions recorded).**

**Where we left off:** FG-425 was NOT merged. The operator replaced the process-supervision design carried on `fix/fg425-project-gate-locking` with a **serialized integration publisher**, then recorded seven binding architecture decisions (AD-1..AD-7) in the ticket. The branch is abandoned-but-preserved. FG-548 filed durably on main. The obsolete original-design run was marked abandoned. **No implementation started** — stopped per the operator's stop condition.

**Picked up next:**
1. **FG-425 — architecture pass, THEN implementation.** Read the ticket body: it now carries the 10-step design, **AD-1..AD-7 (binding)**, the salvage list, and the ONE remaining open design question. Do not re-open the settled ADs.
2. **FG-548** — store deferred-write-txn SQLITE_BUSY under multi-process WAL (snapshot upgrade bypasses busy_timeout). On main. Correctness; independent of the FG-425 redesign.
3. Non-ticket thread — still unfiled, from the 2026-07-12 queue session: (a) review-loop disposition carry-forward (reviewers re-find operator-dispositioned findings; cost FG-540 ~3 loop runs); (b) dashboard in-flight blindness to host-side loop phases (CI-wait/verify have no run/task rows). Already-filed and related: FG-541, FG-547.

**FG-425 binding decisions (AD-1..AD-7) — summary; full text in the ticket:**
- **AD-1** two full validations max (initial + ONE rebuild on moved base); then park with `publish_base_churn`, preserve evidence. No candidate batching in v1.
- **AD-2** one FIFO integration lane per canonical project identity for Forge-owned publication. Worker execution stays PARALLEL; integration/final-validation/publication are ORDERED. CAS still required (external writers, stale state).
- **AD-3** dirty local publish target → named `dirty_publish_target` blocker, refuse BEFORE mutation. Never auto-stash/reset/clean operator-owned state.
- **AD-4** fresh, uniquely-identified integration worktree per attempt. No pooling, no reuse after crash or retry. FG-356 owns eventual cleanup; cleanup is NOT a correctness prerequisite.
- **AD-5** crash between local ref-advance and checkout-update MUST have a defined recovery. Record publication intent BEFORE mutation; recover from `{baseSha, candidateSha, currentTargetSha}`. Never infer publication from working-tree contents.
- **AD-6** validation evidence binds to the immutable `candidateSha`; publish that recorded SHA, never a branch tip or worktree state.
- **AD-7** no automatic gate-process reaping in FG-425. A crashed attempt is abandoned; retry uses a new worktree.

**AD-1 × AD-2 interaction (do not mis-tune):** with the FIFO lane, Forge-owned attempts cannot move each other's base — so `publish_base_churn` fires essentially only on an EXTERNAL writer (operator pushing to the target mid-run). Repeated churn parks are a signal about external write traffic, NOT forge contention. Do not respond by raising the AD-1 bound.

**Only remaining FG-425 design question:** integration-worktree lifecycle MECHANICS under AD-4 — naming/identity scheme for the per-attempt worktree, and how creation/teardown interacts with FG-345 and FG-356. The POLICY is settled by AD-4; the mechanics are open.

**Why the design changed (do NOT re-derive the old one):** the gate PGID sidecars, PID-reuse detection, zombie-leader classification, orphan reaping, and process-identity nonces ALL existed for one reason — the gate ran against the publish target, so an orphaned gate process group could still be mutating the thing about to be published. Once validation runs in a throwaway integration worktree and publication uses the recorded immutable SHA (AD-6), an orphaned gate group is a **resource leak, not a correctness hazard**. **Do not reintroduce pre-merge reaping as a safety mechanism (AD-7).**

**An ADR is still owed** — the ADs live only in the ticket today. Land a `learnings/decisions/` ADR (via `documentation-maintainer`) WITH the implementation, covering the supersession of the process-supervision design and the publisher architecture.

**External state to remember:**
- Branch `fix/fg425-project-gate-locking` (`ce22024`, 11 commits, pushed): **DELIBERATELY UNMERGED AND ABANDONED — do not merge, do not delete.** Salvage: canonical project identity (`projectIntegrationLockKey`), contention visibility (`describeWait`), cross-process publication test harness. DISCARD its long-gate locking + entire process-supervision layer.
- Branch `fg540-recover-schema-validation-evidence` on origin — deliberately UNMERGED (referenced from PR #113's disposition). Do not delete.
- Dashboard runs tmux-owned (launch-dashboard-fstupk, port 8024). Agent-image release-check STALE flag is a known false positive (FG-543) — ignore until fixed.
- `run-fg-425-e1dd27` (obsolete original-design run) was marked **abandoned** via `forge ops repair` on operator authority. Do NOT retry any task from it. `forge ops check` now reports 12 remaining `orphaned_work_may_persist` incidents — all shared-project-dir, tree clean, nothing actually stranded; low signal.

**Decisions worth not relitigating:**
- FG-425's process-supervision design is SUPERSEDED, not "paused." The strict fail-closed reaping rules approved earlier that same session were overtaken by the architecture correction and were never implemented.
- FG-548's direct-to-main backlog filing is accepted — do not redo it through a PR.
- FG-540 reviewer-schema-at-recovery = accepted parity, merged on operator authority; record is PR #113's body.
- FORGE-DEC-024's two stale precedence lines: deliberate non-edit (ADRs amend by supersession).
- Process lessons: `forge backlog file` prints the assigned id — READ it; launch-record `running` = the wrapper, not the work; concurrent sessions/fixers edit the same tree — never assume sole authorship of working-tree changes.

**Shipped (for reference):** FG-539 (PR #112 / `739b0b2`) · FG-540 (PR #113 / `0a2ce3e`) · FG-542 (`931d6e3`, PR #111). FG-543 + FG-548 filed.

**Added 2026-07-13 (late):** **FG-549** filed — `ops check`'s `orphaned_work_may_persist` detector never clears. `detectOrphanedWorkMayPersist` (src/ops/detect.ts:247) JOINs `runs` but never filters `r.status`, so every historical failed task re-surfaces as a HIGH-severity incident forever (the 12 stale ones on this project). Sibling detectors (detect.ts:69, :105) already filter on `TERMINAL_RUN_STATES` (:55) — but note the POLARITY INVERTS: for `retry_orphan` a terminal parent run MAKES the incident; for `orphaned_work_may_persist` a terminal parent run makes it STALE. Same class as the closed FG-504/FG-505 (incidents that never clear). Ticket carries three candidate policies (suppress / downgrade / evidence-conditional) — pick one and state the reasoning in code. Does NOT block FG-425.
