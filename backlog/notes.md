**Last session ended 2026-07-11.**

**Where we left off:** Three arcs, all closed cleanly: (1) the operator's 5-item autonomous queue shipped 5/5; (2) the operator's 5-finding review resolved 5/5 (FG-530 completed at full coverage per their build-don't-narrow ruling; FG-520 shipped with the image rebuilt); (3) a deep forensic investigation of the constant background-task SIGTERM kills, ending in operator-authored FG-535 + orchestrator-filed FG-536 with live instrumentation armed. Last thread was the SIGTERM attribution — RESOLVED CONCLUSIVELY at 18:13:49: the SA_SIGINFO sentinel captured si_pid=17165, the session's own Claude Code harness process, sweeping both bait tasks in one second. Claude Code confirmed as the killer; Supacode exonerated. Display was ON, so lock/display-off is not a necessary trigger. Recorded in FG-535 (ATTRIBUTION RESOLVED section).

**Picked up next:**
1. Attribution is DONE (si_pid=17165 = Claude Code harness; see FG-535). The probe is concluded — sentinel binary kept at ~/.forge/sigterm-probe/ for FG-535's optional trigger-characterization cells; no processes left running. NOTE: macOS ships no setsid(1) — the durable owner for long forge commands is tmux, per FG-535's mitigation section.
2. FG-535 (durable launcher + Claude/Supacode attribution A/B matrix) — the operational fix for lost agent work. Its "Immediate Operational Mitigation" section is standing guidance NOW: long forge commands go under a durable tmux owner via a short synchronous Bash call, polled through forge durable state; do NOT let Bash run_in_background own them. FG-536 is the in-product complement (docker-detached invoke) — implement after or alongside.
3. FG-532 (gate reject discards the rejected task's result) — small isolated fix, best first code pick; its FG-530 matrix cell flips to a passing assertion when fixed. Then FG-531 (awaiting_red wedge, single-step + fanout-parent variants) and FG-533 (pre-container running wedge — preserve the invoke/manual exemption per its AC).

**External state to remember:**
- ~/.forge/sigterm-probe/ holds the sentinel binary (log path as argv[1]) + the smoking-gun sentinel.log; nothing running.
- agent-dev-worker image is CURRENT (rebuilt from merged FG-520 content; release-doctor now flags COPY'd-input staleness). ~/.forge/forge.db carries the live FG-523 gate_on_verdict migration (backup: forge.db.backup-pre-fg523-20260710-213303).
- Dashboard (PID 21748) still predates FG-521's server-side change — restart at operator convenience.
- The operator may set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 (needs session restart) per FG-535 — if set, background dispatch is unavailable and the tmux pattern is mandatory.
- Upstream refs for the kill bug: anthropics/claude-code #76249 (closest match, 2.1.206), #72851, #68625, #25188. Host runs Claude Code 2.1.207. Operator may post the forensics upstream.

**Decisions worth not relitigating:**
- SIGTERM kill attribution: PROVEN — Claude Code harness (si_pid capture, FG-535). Closed question; only the trigger condition (what makes the harness sweep) remains optionally characterizable.
- FG-530's coverage boundary is EXHAUSTIVE (zero-gap write⇒probed guard) per operator ruling — no reasoned-allowlist deferrals.
- FG-535/FG-536 split is deliberate: 535 = launcher durability + attribution (operator-authored), 536 = docker-detached execution by construction. Cross-linked; don't merge them.
- Review-loop lessons re-proven: slice work needs a slice-scoped ticket (FG-529 precedent); backlog-file findings are the orchestrator's to fix directly; a killed loop's uncommitted fixer work is recoverable (verify on host, commit with round attribution).
- forge-test's mirror compares BYTES deliberately (FG-534 close records why) — don't "optimize" back to stat metadata.
- The 6 failed engineer task rows from 2026-07-11 are audit residue of harness kills, all recovered and merged — kept failed by convention, not stuck.

**Shipped (for reference):** FG-410 (PR #99, lost-update-safe campaign item writes + stress proof) · FG-521 (PR #100, operator read-surface batch) · FG-523 (PR #101, tests_run enforcement + persisted gate_on_verdict, live shared-DB migration) · FG-529+FG-528 (PR #102, lineage classifier slice 1 + ready-queue re-admission fix; FG-477 stays open) · FG-530 (PR #103, crash-point simulator: ~60 kill points, 5 invariants, worktree lane, meta-AC; found FG-531/532/533) · FG-520+FG-534 (PR #104, forge-test re-sync/deps-integrity/FATAL contract + image rebuild) · Filed: FG-522, FG-524–FG-527, FG-531–FG-533, FG-535 (operator), FG-536.
