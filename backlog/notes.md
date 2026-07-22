**Last session ended 2026-07-22.**

**Where we left off:** FG-565 (Slice 6 — durable-continuation closeout) shipped + closed (merge `1b3989e`, PR #151), driven end-to-end unattended. Epic FG-561's continuation slices 0–6 are all done; the session ended clean at merge + closeout + epic reconciliation. No open thread mid-flight.

**Picked up next:**
1. **FG-572** — installed-surface compatibility across a promotion (the ONLY thing keeping epic FG-561 open). Children: FG-581 (post-promotion RACI compile only warns), FG-582 (git-hook symlink anchoring — decision already made: symlink-through-current), FG-583 (non-atomic seed cp loop; depends on FG-577, landed). Closing FG-572 closes the epic. Release-promotion robustness, not a continuation-model gap.
2. **FG-599** — durably record normal-delivery + replay-recovery so Q2 delivery-mode is a positive record (finding against FG-562/FG-563; the storage scope FG-565's no-new-features fence excluded).
3. **FG-600** — small FG-565 follow-ups: `forge continuation` should not call `ensureForgeDirs` (read-only parity with lost-signals, ~2 lines); F21 should drive the real `forge cancel` CLI not `failTask(cancelled)`.

**External state to remember:**
- Writer clone `~/code/forge-agent-work`: the merged branch `feat/fg565-slice6-closeout` was deleted on merge — `git reset --hard origin/main` before next use.
- Control checkout `~/code/forge` is the LIVE npm-linked control plane; promotion is NOT in force on this host, so writing agents ALWAYS use the standalone clone, never `main`. Read-only reviewers can mount `main` read-only.
- `forge-dev` is not on PATH — invoke policy-surface re-renders as `./bin/forge-dev upgrade` from the control checkout.

**Decisions worth not relitigating:**
- Q2 delivery-mode gap: operator chose honest-docs + follow-up (FG-599), NOT build-the-feature into FG-565 (fence-excluded). `forge lost-signals` is a recovery ledger, not a delivery ledger — corrected across concepts/quick-start + seed + CLAUDE.md (`3a30546`), parity-asserted by the G5 test.
- Final red-wide returned 2 medium findings (read-only dir-creation; F21 CLI-vs-API fidelity) — both fail-safe/fidelity with core invariants met, dispositioned to FG-600 and merged over, NOT blockers. Fix-round budget (3) fully used; none exceeded.
- T9 (process anchoring under mid-flight promotion) is settled-by-execution (FG-553 plan); FG-565 verified it, did not reopen it. FG-582's installed-pointer anchoring is separately decided (symlink-through-current).
- Build reds caught a FAKE F20 proof + an F21 that bypassed the real transition — a targeted fixer made both genuinely real. A closeout test that can't be exercised (e.g. real Docker) is honestly scoped to what it CAN prove + documented, never faked.

**Shipped (for reference):**
- **FG-565** (`1b3989e`, PR #151) — Slice 6 closeout: read-only `forge continuation show/list` evidence surface (Q3–Q7 from durable state); F20/F23–F24/F21 cross-layer seam tests; G5 docs-parity test; lost-signals recovery-ledger correction; PRD/docs reconciliation. Evidence ledger `docs/plans/fg565-closeout-evidence-ledger.md`; AC-evidence grid in the closed ticket. Follow-ups FG-599, FG-600.
