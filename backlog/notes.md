**Session 2026-07-11 (evening): controlled SIGTERM experiment — STOPPED ON CONFIRMED KILL at item 3/4.**

**Queue state (operator's strict sequence):**
1. FG-532 — SHIPPED + CLOSED (PR #105, merge 09ac1ea; FG-530-B cell flipped; docs updated).
2. FG-513 — SHIPPED + CLOSED (PR #106, merge 56c0d07; reviewer pinned per loop + one same-round model_error retry on the defaults path; new event review_loop.reviewer_model_error_retry; 3 docs + SCHEMA-CONTRACT updated; root cause = per-dispatch policy re-read + mid-loop operator edit, proven from task rows resolvedBy + policy mtime).
3. FG-531 — CODE COMPLETE, UNMERGED. PR #107 open, branch fix/fg-531-awaiting-red-crash-window (2 commits + docs). Full matrix green locally (1234 pass, only FG-533 todo left); both FG-530-A cells flipped; awaiting_red sweep in reconcile with run-lock liveness probe. Its review-loop round 1: reviewer needs_fix with ONE REAL finding — src/v2/fg530-crash-worktree.worktree.test.ts (the WORKTREE lane) still asserts the old FG-530-A wedge shape; the fixer was mid-edit when killed. Partial fixer diff preserved: in-tree (M fg530-crash-worktree.worktree.test.ts, uncommitted, on the branch) + snapshot at ~/.forge/sigterm-probe/fg531-fixer-partial-93be42.diff. NEXT: finish that fixture fix (worktree-lane test), run test:worktree, re-run review-loop, merge on closeable+CI, close with AC walk.
4. FG-533 — NOT STARTED (queue stopped per stop condition).

**THE KILL (full forensics in FG-535's 'SECOND CONFIRMED KILL' section):** harness background task b9cr8t82y (review-loop FG-531) reported status:killed ~19:10:57 PDT, no TaskStop; fixer container forge-task-engineer-93be42 exit 143 (OOMKilled false) mid-tool-call; DB row task-engineer-93be42 stranded running in run-review-loop-fg-531-dd1eda (left as-is deliberately — evidence; recover AFTER the operator reviews). Plain iTerm, SUPACODE_*/ZMX_* absent, no tmux/detach. Same backgrounded pattern completed 3x earlier in-session. Proves: Supacode NOT NECESSARY for the failure. Sender for this event unproven (sentinel died with the old session at 18:13; its capture si_pid 17165 = that session's own harness).

**Also this session:** FG-535 attribution evidence from the OLD session verified first-hand and landed on main (695ce87, cherry-picked off this branch where the other live session had committed it); cross-session interference hazard noted — two live orchestrators share this working tree.

**Recommended next controlled comparison (operator's design):** Supacode-with-hooks-disabled A/B; and reconcile FG-535/FG-536 — FG-536's user-away/lock-lifecycle CAUSE claim remains unproven (this kill occurred user-away with display state unknown), but docker-detached execution (FG-536) would have saved the fixer's round by construction.

**Decisions not to relitigate:** same as prior handoff (FG-530 exhaustive coverage; FG-535/536 split; forge-test byte-compare; failed engineer rows = audit residue).
