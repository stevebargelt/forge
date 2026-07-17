**Last session ended 2026-07-17.** ⚠️ **RECOVERY MODE IS ACTIVE — FG-561 automatic advancement is PAUSED.**

**Where we left off:** A very long FG-561 autonomous run shipped 3 FG-572 children (FG-577/578/580) but over-drove scope — it recorded advisor-generated offline/CDN vendoring as an "operator decision" and grew open backlog by +7. The operator issued a two-part recovery instruction; both passes are applied and pushed. **Nothing is mid-flight; nothing auto-resumes.**

**RECOVERY GOVERNOR (operator, 2026-07-17 — DO NOT DROP):** No new ticket or AC may be created from a finding unless it directly falsifies an existing accepted acceptance criterion or demonstrates credible in-scope data-loss/security harm. Optional hardening is deferred by default. Product properties, new test environments, dependency policies, and required CI gates require explicit operator authorization. Campaign health is measured by **net open-backlog reduction**. Do not dispatch agents/pipelines/review-loops or start implementation children without an explicit operator go.

**Picked up next (NONE auto-starts — all gated on explicit operator go):**
1. **FG-579 is the next functional campaign blocker** — a CURRENT silent workflow-misrun path (seed-drift omits `workflows`, so a stale installed workflow mis-runs undetected). **Must not start without a separate explicit operator go.** Completing it must NOT auto-dispatch FG-581/582/583/585/586.
2. **Two active orchestration-integrity defects, kept, not started:** FG-585 (a run reports `status: complete` while its gate:auto docs phase silently never ran — false completion) and FG-586 (a malformed authoritative red result.json silently erases a blocking verdict — happened twice: a leading `+`, and internal bad-byte). Fix direction on FG-586 is fail-closed-on-unreadable, not recovery-by-stripping.
3. **Deferred FG-572 promotion-path children:** FG-581 (post-promotion RACI compile only warns), FG-582 (hooks anchoring — T9 decided = symlink-through-`current`), FG-583 (non-atomic cp-loop install → mixed workflow set). Valid but not current failures (promotion never activated on this host).

**External state to remember:**
- **Promotion NEVER activated on this host, by design.** `~/.forge/{current,releases,interpreters}` absent; host RACI untouched since Jul 12; no `npm link`, no `forge init`/`upgrade` run. Real host never promoted.
- **`~/code/forge-fg571` is the standalone writer clone** — synced to origin/main between tickets, branch-per-ticket. Reusable.
- **A second orchestrator session was active on the operator's behalf** this run (filed FG-588, made the FG-580 Option-A decision on main). Two sessions on one main caused branch divergence 3× (backlog commits) — rebase-before-close if it recurs.

**Decisions worth not relitigating:**
- **FG-580 offline code is KEPT as landed** (`b6c6542`). Removing merged working code is needless churn/regression risk. Offline was NOT an original product requirement (operator approved release BUNDLING only). Keeping it authorizes NO further offline hardening, Chrome CI, or branch-protection work. Do not modify/revert FG-580 code.
- **FG-584 WITHDRAWN** (fanout sequencing friction is real but falsifies no accepted AC / no data loss) and **FG-589 WITHDRAWN** (unapproved offline CI-gate requirement). Both not implemented, no closed_commit, no replacement tickets. Do not resurrect.
- FG-580 Option A (bundle dashboard, one release identity) settled by the operator; do not reopen.
- FG-577 threat boundary settled: same-UID `$FORGE_HOME` write = accepted honest limit; no chmod/permission machinery; content-addressing is the one identity mechanism.

**Shipped (for reference):**
- **FG-577** (5a) — `forge upgrade` resolves release-owned assets from the executing release, not the dev checkout (`b5add06`, PR #126).
- **FG-578** (5b) — `FORCE=1` no longer clobbers the operator-authored RACI; `AUTHORED_EXEMPT=(agents constraints raci)` create-only (`d9dacbb`, PR #127). **FG-587** closed with it.
- **FG-580** (5g) — dashboard bundled into the promoted release, mandatory at build+promote, runs from a release; offline vendoring landed (unrequired, kept) (`b6c6542`, PR #128).
- Recovery record corrections: FG-561 dashboard-availability closeout condition recorded as MET by FG-580.
