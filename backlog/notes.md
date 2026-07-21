**Last session 2026-07-21. FG-565 (Slice 6 — durable-continuation closeout) SHIPPED + CLOSED (merge `1b3989e`, PR #151). Epic FG-561 core complete.**

**What shipped (FG-565):** the closeout slice proving the durable-continuation model composes as one system.
- **G1** — new read-only `forge continuation show/list [--state blocked] [--consumer-kind] [--json]` over the continuations + continuation_stale_observations tables (durable-state-only, bounded LIMIT, no N+1, no schema/write) — answers operator questions Q3–Q7 without transcript archaeology.
- **G2–G4** — F20 cross-layer seam test (real tmux ownership + honest reconcile-bound container recovery), F23/F24 broken-source tests (this + unrelated project, hermetic), F21 cancelled-candidate-surfaced assertion (real cancel→campaign_system transition).
- **G5** — docs-parity test (quick-start/concepts vs seed; launch-wait + ScheduleWakeup-watchdog-only + lost-signals delivery-mode, falsifiable).
- **G6 + policy** — corrected the `forge lost-signals` overclaim to "recovery ledger, not a delivery ledger" across concepts/quick-start AND the orchestrator-policy surfaces (seed + CLAUDE.md marker block, `3a30546`, re-rendered via `forge-dev upgrade`).
- Evidence ledger: `docs/plans/fg565-closeout-evidence-ledger.md`. AC-evidence grid persisted in the closed ticket (13 met rows). CI green on the merge head (`test` + `test-extended`).

**Process notes worth keeping:** the build reds caught a FAKE F20 proof (fixtures, non-reddening mutant) and an F21 that bypassed the real transition — a targeted fixer made both genuinely real. The review-loop then hit needs_fix_max_rounds on a Q2 delivery-mode overclaim (lost-signals only durably records watchdog recoveries). Operator chose "honest docs + follow-up, close" (the ticket's verify-and-surface model). Final red-wide returned 2 medium fail-safe findings (read-only dir-creation; F21 CLI-vs-API fidelity) — dispositioned to FG-600, core invariants met, merged. Fix-round budget (3) was fully used.

**Open follow-ups filed this session:**
- **FG-599** — durably record normal-delivery + replay-recovery so Q2 is a positive record (finding against FG-562/FG-563; genuinely-new storage scope FG-565's no-new-features fence excluded).
- **FG-600** — `forge continuation` should not call `ensureForgeDirs` (read-only parity with lost-signals); F21 should drive the real `forge cancel` CLI not `failTask(cancelled)`. Both fail-safe/fidelity.

**Epic FG-561 status:** all continuation slices 0–6 DONE. Reconciled (see the epic's 2026-07-21 note). **Remains OPEN only on FG-572** (Slice 1 Child 5 — installed-surface compatibility across a promotion): FG-581 (post-promotion RACI compile only warns), FG-582 (git-hook symlink anchoring — decision made: symlink-through-current), FG-583 (non-atomic seed cp loop). These are release-promotion installed-surface robustness, NOT continuation-model gaps.

**Repo state:** `main` @ `0af2c6e`+ (FG-561 reconcile committed on top). Writer clone `~/code/forge-agent-work` — the merged branch `feat/fg565-slice6-closeout` was deleted on merge; reset it to origin/main before next use. Control checkout `~/code/forge` is the LIVE npm-linked control plane — never dispatch writing agents at it; promotion is NOT in force, so writers use the standalone clone.

**Picked up next (operator's pick):**
1. **FG-572 installed-surface compatibility** — the only thing keeping FG-561 open. FG-582's T9/installed-pointer anchoring decision is already made (symlink-through-current); FG-583 depends on FG-577 (landed). Closing FG-572 closes the epic.
2. **FG-599 / FG-600** — the FG-565 follow-ups (small; FG-600 is a ~2-line read-only cleanup + a test-fidelity refinement).
3. Anything else the operator prioritizes.
