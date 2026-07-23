**Last session ended 2026-07-23.**

**Where we left off:** FG-583 (FG-572 Child 5h) is fully shipped and closed after a reopen — the last user direction (run a fresh adversarial review, fix findings, re-close only on green CI) is complete. The one open thread is the FG-553 → FG-561 closure, deliberately NOT done this session.

**Picked up next:**
1. **FG-553 aggregate-AC walk, then FG-561 close.** All FG-561 slices are done EXCEPT FG-553 (Slice 1); FG-553's six children (FG-567–572) are all closed, so it's structurally unblocked. But FG-553 has SUBSTANTIVE aggregate acceptance criteria — BD-14 (control-plane availability independent of the caller's environment), "machine-wide blast radius ELIMINATED — documenting it does not close this ticket", R1+R2 provenance — that require walking the aggregate shipped evidence across the children, NOT a "children are done" rubber-stamp. Do that walk; if it genuinely passes, close FG-553 then FG-561 (epic) with evidence grids. If any aggregate AC is unmet, it stays open — finish it.
2. **(non-ticket, operator) Rebase the control checkout's local commits.** `~/code/forge` main has 4 unpushed local commits unrelated to this session (see External state) — the operator should rebase them onto origin/main; nothing for the orchestrator to auto-do.
3. Otherwise the active backlog is broad (dashboard work FG-348/349/386/395/402, worktree FG-345/356, FG-477 lifecycle evaluator, FG-496 DB-backed backlog, etc.) — no forced next; pick by operator priority.

**External state to remember:**
- Control checkout `~/code/forge` (the live npm-linked `forge`) main has **4 UNPUSHED local commits** predating FG-583 — competitive-research docs + a working-plan backlog file — DIVERGED from origin, not fast-forwardable. Left untouched; operator rebases them. Because it's diverged, `git pull` there won't fast-forward until resolved.
- Writer clone `~/code/forge-agent-work` on main synced to origin (`6a6afd2`); both FG-583 feature branches merged + deleted.
- Host test caution: running tests directly on the host with `env -u FORGE_HOME` can leak into the real `~/.forge` (a stray `constraints/note.md` appeared mid-session and was removed, and it blocked all `forge invoke` until cleared). Isolate FORGE_HOME per test, or check `~/.forge/constraints` for frontmatter-less strays if invokes start failing.

**Decisions worth not relitigating (this session):**
- Routing policy under a generation: `route compile` (host) / `raci apply` are REFUSE-and-DIRECT, NOT republish — a republish from an operator action would mix release-owned workflows/runtimes with an operator-authored policy change in one manifest, blurring release provenance (architect risk #3). Initial + subsequent generation publication stays exclusively `forge upgrade`'s job.
- Fresh-install dispatchability is fixed via DOCUMENTATION (the required `forge upgrade --skip-project` bootstrap step), NOT by adding publication to `install-seeds.sh` — that script runs pre-promotion (dev bytes), and a promote-time publish is a two-pointer swap problem.
- FG-605 (route-preflight-reads-flat-policy) was ABSORBED into FG-583's routing authority model, not left as a narrow follow-up — closed.
- The first FG-583 close (8272e5b) was premature/overclaimed; reopening was correct. Don't re-close a ticket on a "children/tests pass" basis without walking its actual AC — the exact trap FG-553 must avoid next.

**Shipped (for reference):**
- **FG-583** — host seeds as one atomic generation + move-the-invariant (no flat dispatch fallback) + full routing authority model (all host-policy consumers read the generation; refuse-and-direct; policy manifest-verified; preflight/dispatch anchored) + documented bootstrap + real-CLI acceptance test. `8272e5b` (PR #154) + `b0dd651` (PR #155). Corrected AC grid in the closed ticket.
- **FG-572** — umbrella closed (all 7 installed-surface children FG-577–583 done).
- **FG-605** — closed (absorbed into FG-583).
