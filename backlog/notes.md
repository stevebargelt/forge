**Last session ended 2026-07-30.**

**Where we left off:** The operator's authorized queue ran to completion autonomously: FG-608 (live DB cutover) → FG-645 → FG-642 → the evidence-led program FG-638 → FG-639 → FG-640 (+ FG-541 superseded) → FG-647, every ticket merged on green ten-check CI and closed on an AC evidence walk. The evidence-led review lifecycle is FULLY LIVE: `feature` declares `review_mode: evidence_led` (active generation gen-tzoggznmyy), Change 0 is retired from the policy blocks, `forge review-loop` is deprecated, and FG-647 was reviewed end-to-end by `forge review` itself — the first production `settled` review, including a real fix cycle and the eight-check shipping review with per-test-validated AC evidence.

**Picked up next:**

1. **FG-649 — coordinator candidate re-anchoring after post-hoc fix commits.** The sharpest live gap: it bit twice (the FG-639 pilot and FG-647's first recheck bound to a pre-fix candidate). The fix→docs-rebind→recheck ordering routes around it, but every future review pays that tax until fixed. Folds in: `continue` resolving the dispatch project from CWD instead of the persisted workspace, and fix-batch payloads including already-resolved findings.
2. **FG-650 — validator tolerance for honest extra keys.** Hit three times live (discovery twice, recheck once); reviewers author correct outcomes with legacy keys appended and the strict root schema refuses them whole. Retry and accept-lens are the designed workarounds; tolerate-and-record or prompt hardening is the fix.
3. **FG-609 (FG-496 Slice D, queue primitives)** is the next PLAN implementation item — NOT yet operator-authorized; ask before dispatching.

**External state to remember:**
- ntfy was DOWN the entire run — every `forge notify` failed `network: fetch failed`; milestones are recorded in the DB but nothing pushed.
- Docker Hub token still presumed unrotated (carried since 2026-07-28).
- Three DB restore points: forge.db.pre-fg608.bak, pre-fg638-ledger.bak (287MB), pre-fg639-coordinator.bak (288MB). All migrations this run were additive; integrity ok; parity guard green.
- FG-646 is explicitly OFF-QUEUE (operator instruction 2026-07-30) — do not work it.
- Two stale orchestrator-session run rows (bf2fa4, 085fdf) remain active in the DB — no liveness signal exists; do NOT cancel by age.

**Decisions worth not relitigating:**
- D5: EXPECTED_TMUX_FAILURES baseline 10→14 accepted on the operator's behalf (the 4 additions are FG-569's tmux-gated tests, verified from the script's own inventory). Veto path: revert 0594424e's script hunk.
- D9: FORGE_CHROME_BIN is authoritative when set — a wrong path errors by name instead of silently using another Chrome.
- D10: findings against frozen backlog/*.md snapshots are resolved by annotating the DB ticket body, never by writing the frozen file.
- D13: accepted_risk authority derives mechanically from the finding row (invariant/acceptance/security/data-integrity markers) — a caller cannot omit it.
- D17: two WRITING agents never share a clone concurrently (a docs-maintainer observed a fixer's uncommitted edits mid-pass); read-only reds may share.
- D18/D19: FG-639's model review closed at three passes with the live pilot as the residual check; the pilot's remaining gap was FILED (FG-649), not driven — reviews of the review engine stop when the findings become another ticket's scope.
- The forge-on-forge migrate predicate concern from the previous handoff did NOT reproduce and stays parked pending a demonstrated failure.

**Shipped (for reference):** FG-608 (`f391b544` machinery + live cutover: 598 tickets, mode db, store banner `store: db`), FG-645 (`1754c386`, 129 in-container reds → 0, harness dirty-tree fix), FG-642 (`0dab8f8d`, browser tier restored + dashboard_browser in required CI), FG-638 (`ea6a9101`, review ledger + disposition CLI), FG-639 (`d118aff` coordinator + `bccec80`/`a6336f5` pilot fixes), FG-640 (`ed9394e`, review_disposition gate + feature migration + Change-0 retirement), FG-541 (superseded on the guarded evidence mapping), FG-647 (`907c899`, zero skips everywhere, first settled production review). Filed: FG-649, FG-650.
