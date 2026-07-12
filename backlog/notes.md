**Last session ended 2026-07-11.**

**Where we left off:** Three arcs, all closed cleanly: (1) the operator's 5-item autonomous queue shipped 5/5; (2) the operator's 5-finding review resolved 5/5 (FG-530 completed at full coverage per their build-don't-narrow ruling; FG-520 shipped with the image rebuilt); (3) a deep forensic investigation of the constant background-task SIGTERM kills, ending in operator-authored FG-535 + orchestrator-filed FG-536 with live instrumentation armed. Last thread was the SIGTERM attribution work — evidence strongly favors Claude Code's own user-away/lock background-task lifecycle (upstream #76249/#72851 signatures; 9/11 kills during display-off; controlled repro of the signal path; Supacode unexcluded but unsupported).

**Picked up next:**
1. **Check ~/.forge/sigterm-probe/sentinel.log FIRST** — if a kill happened since 2026-07-11 ~17:24, the SIGNAL line's si_pid names the killer conclusively (17165 = the old session's claude harness → Claude Code confirmed). A sentinel + node decoy ran as background bait in the old session; a setsid-detached ps sampler (ps-samples.log) resolves transient pids. NOTE: those baits die when the OLD session ends — a dead sentinel with no SIGNAL line before session-end means no kill occurred, not a negative result.
2. FG-535 (durable launcher + Claude/Supacode attribution A/B matrix) — the operational fix for lost agent work. Its "Immediate Operational Mitigation" section is standing guidance NOW: long forge commands go under a durable tmux owner via a short synchronous Bash call, polled through forge durable state; do NOT let Bash run_in_background own them. FG-536 is the in-product complement (docker-detached invoke) — implement after or alongside.
3. FG-532 (gate reject discards the rejected task's result) — small isolated fix, best first code pick; its FG-530 matrix cell flips to a passing assertion when fixed. Then FG-531 (awaiting_red wedge, single-step + fanout-parent variants) and FG-533 (pre-container running wedge — preserve the invoke/manual exemption per its AC).

**External state to remember:**
- Instrumentation live on the host: ~/.forge/sigterm-probe/ (sentinel binary takes a log path as argv[1] for FG-535's A/B cells; sampler loops detached — kill it via `pkill -f sigterm-probe/sampler` when the investigation closes).
- agent-dev-worker image is CURRENT (rebuilt from merged FG-520 content; release-doctor now flags COPY'd-input staleness). ~/.forge/forge.db carries the live FG-523 gate_on_verdict migration (backup: forge.db.backup-pre-fg523-20260710-213303).
- Dashboard (PID 21748) still predates FG-521's server-side change — restart at operator convenience.
- The operator may set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 (needs session restart) per FG-535 — if set, background dispatch is unavailable and the tmux pattern is mandatory.
- Upstream refs for the kill bug: anthropics/claude-code #76249 (closest match, 2.1.206), #72851, #68625, #25188. Host runs Claude Code 2.1.207. Operator may post the forensics upstream.

**Decisions worth not relitigating:**
- SIGTERM kill attribution: harness-favored, Supacode-possible-but-unsupported — per the operator's own analysis (recorded in FG-535). Don't re-argue from idle-gap timing alone: ALL 59 background commands (31 completed / 17 failed / 11 killed) shared that lifecycle, so it discriminates nothing.
- FG-530's coverage boundary is EXHAUSTIVE (zero-gap write⇒probed guard) per operator ruling — no reasoned-allowlist deferrals.
- FG-535/FG-536 split is deliberate: 535 = launcher durability + attribution (operator-authored), 536 = docker-detached execution by construction. Cross-linked; don't merge them.
- Review-loop lessons re-proven: slice work needs a slice-scoped ticket (FG-529 precedent); backlog-file findings are the orchestrator's to fix directly; a killed loop's uncommitted fixer work is recoverable (verify on host, commit with round attribution).
- forge-test's mirror compares BYTES deliberately (FG-534 close records why) — don't "optimize" back to stat metadata.
- The 6 failed engineer task rows from 2026-07-11 are audit residue of harness kills, all recovered and merged — kept failed by convention, not stuck.

**Shipped (for reference):** FG-410 (PR #99, lost-update-safe campaign item writes + stress proof) · FG-521 (PR #100, operator read-surface batch) · FG-523 (PR #101, tests_run enforcement + persisted gate_on_verdict, live shared-DB migration) · FG-529+FG-528 (PR #102, lineage classifier slice 1 + ready-queue re-admission fix; FG-477 stays open) · FG-530 (PR #103, crash-point simulator: ~60 kill points, 5 invariants, worktree lane, meta-AC; found FG-531/532/533) · FG-520+FG-534 (PR #104, forge-test re-sync/deps-integrity/FATAL contract + image rebuild) · Filed: FG-522, FG-524–FG-527, FG-531–FG-533, FG-535 (operator), FG-536.
