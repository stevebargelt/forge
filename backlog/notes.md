**Last session ended 2026-07-13 (FG-425 architecture correction).**

**Where we left off:** FG-425 was NOT merged. The operator reviewed the process-supervision design carried on `fix/fg425-project-gate-locking` and **replaced it with a serialized integration publisher**. The branch is abandoned-but-preserved; FG-425 has been rescoped and retitled to the new design. FG-548 was filed durably on main. No implementation was started — stopping here per the operator's stop condition.

**Picked up next:**
1. **FG-425 — architecture pass on the new design, THEN implementation.** Rescoped to: build candidate `C` in a dedicated integration worktree, validate/test/red/review against exact `C`, then publish to the target through a SHORT compare-and-swap window (confirm target still at base `B` → fast-forward to `C`; if the target moved, rebuild on the new base and rerun gates). Local target: the short lock covers only the FF + working-tree checkout update. Remote target: expected-SHA lease / CAS push. Read the ticket body — it carries the design, the salvage list, and three open design questions that must be settled BEFORE implementation.
2. **FG-548** — store deferred-write-txn SQLITE_BUSY under multi-process WAL (snapshot upgrade bypasses busy_timeout). Now on main. Correctness; independent of the FG-425 redesign.
3. Non-ticket thread — still unfiled, from the 2026-07-12 queue session: (a) review-loop disposition carry-forward (reviewers re-find operator-dispositioned findings; cost FG-540 ~3 loop runs); (b) dashboard in-flight blindness to host-side loop phases (CI-wait/verify have no run/task rows). Already-filed and related: FG-541, FG-547.

**Why the FG-425 design changed (do NOT re-derive the old one):** the gate PGID sidecars, PID-reuse detection, zombie-leader classification, orphan reaping, and process-identity nonces ALL existed for one reason — the gate ran against the publish target, so an orphaned gate process group could still be mutating the thing about to be published. Once validation runs in a throwaway integration worktree, an orphaned gate group is a **resource leak, not a correctness hazard**: a stale candidate simply loses the CAS at publish time and is rebuilt. Orphan cleanup becomes GC, never a correctness gate. **Do not reintroduce pre-merge reaping as a safety mechanism.**

**Open design questions on FG-425 (settle in the architecture pass):**
- Bounded retry on a moved base — step 8 is a retry loop, each rebuild re-runs a ~10min suite; under steady merge traffic a run can starve. Decide the bound (N attempts → actionable failure); candidate batching probably unnecessary at forge's concurrency but the assumption should be stated.
- Dirty target working tree — the publication window is only "tiny" if the target checkout is clean. Refuse on dirty, or stash?
- Integration worktree lifecycle: per-run-ephemeral or pooled? Interacts with FG-345 / FG-356.

**External state to remember:**
- Branch `fix/fg425-project-gate-locking` (`ce22024`, 11 commits, pushed): **DELIBERATELY UNMERGED AND ABANDONED — do not merge, do not delete.** Salvage from it: canonical project identity (`projectIntegrationLockKey`, realpath-canonicalized), contention visibility (`describeWait`), and the cross-process publication test harness. DISCARD its long-gate locking + entire process-supervision layer.
- Branch `fg540-recover-schema-validation-evidence` on origin — stricter recover-time schema validation, deliberately UNMERGED (referenced from PR #113's disposition). Do not delete.
- Dashboard runs tmux-owned (launch-dashboard-fstupk, port 8024). Agent-image release-check STALE flag is a known false positive (FG-543) — ignore until fixed.
- `forge ops check` reports a `stuck_run` (`run-fg-425-e1dd27`: active, all 6 tasks terminal, will never progress) plus 12 low-signal `orphaned_work_may_persist` incidents (all shared-project-dir, tree is clean, nothing actually stranded). The stuck_run wants `forge ops repair run-fg-425-e1dd27` (autonomy: ask).

**Decisions worth not relitigating:**
- FG-425's process-supervision design is superseded, not "paused." The strict fail-closed reaping rules the operator approved earlier that same session were overtaken by the architecture correction and were never implemented.
- FG-540 reviewer-schema-at-recovery = accepted parity, merged on operator authority; record is PR #113's body.
- FORGE-DEC-024's two stale precedence lines: deliberate non-edit (ADRs amend by supersession).
- Process lessons: `forge backlog file` prints the assigned id — READ it; launch-record `running` = the wrapper, not the work; concurrent sessions/fixers edit the same tree — never assume sole authorship of working-tree changes.

**Shipped (for reference):** FG-539 (PR #112 / `739b0b2`) · FG-540 (PR #113 / `0a2ce3e`) · FG-542 (`931d6e3`, PR #111). FG-543 + FG-548 filed.
