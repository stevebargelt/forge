**Last session ended 2026-07-22.**

**Where we left off:** FG-581 (FG-572 Child 5f — post-promotion RACI compile-failure refusal) shipped, closed, and its backlog closeout corrected (FG-603 withdrawn, FG-582 reconciled to unblocked). No thread mid-flight.

**Picked up next:**
1. **FG-582** (FG-572 Child 5e — installed git hooks anchoring) — now **UNBLOCKED and ready to implement**. Operator decision settled: `forge init` hook install targets **symlink-through-`$FORGE_HOME/current`** (pin-at-install rejected), so promotion re-points hooks atomically. Both blockers cleared (FG-577 landed `b5add06`). Scope also: disambiguate `init.ts:185` `exists-other` (stale forge hook = re-point vs foreign hook = never clobber), preserve dev-checkout behavior when there is no `current` pointer, and reconcile the two stale slash-command-symlink docs it owns (`docs/concepts.md:40`, `docs/quick-start.md:80`) in the same change.
2. **FG-583** (FG-572 Child 5h — non-atomic host seed cp loop; an interrupted upgrade can expose a mixed-but-Zod-valid workflow set). Depends on FG-577 (landed). Closing FG-582 + FG-583 closes FG-572 → closes epic **FG-561**.
3. **FG-599** (positive Q2 delivery-mode record) and **FG-600** (FG-565 follow-ups: `forge continuation` should not `ensureForgeDirs`; F21 should drive the real `forge cancel` CLI).

**External state to remember:**
- Writer clone `~/code/forge-agent-work`: on branch `feat/fg581-post-promotion-raci-refusal` (merged as `dcc19ec`, branch NOT deleted). `git reset --hard origin/main` before next use.
- Control checkout `~/code/forge` is the LIVE npm-linked control plane; promotion NOT in force here, so writing agents ALWAYS use the standalone clone, never `main`. Read-only reviewers may mount `main` RO.
- PR #152 branch left undeleted on GitHub.

**Decisions worth not relitigating:**
- FG-581's fix is on-disk artifact-neutralization (fail-closed: quarantine → unlink → loud "still authoritative"), NOT message-tweaking — the exit-1 refusal machinery pre-existed. The discriminating RED test asserts stale-policy NON-consumption on disk, not exit status.
- FG-581 is mode-agnostic: the Step-3 recompile/quarantine runs regardless of dev/release mode (`mode` only gates Steps 1-2 dev-advancement). A promoted-`mode:"release"` acceptance test was added to prove the release path reaches it.
- **FG-603 WITHDRAWN — do not re-file.** Operator explicitly declined a follow-up for the duplicated release-mode `--json`/verbatim-construct assertions; the evidence was accepted as compositionally complete (those assertions are already proven mode-agnostically in dev mode).
- The red-wide reviewer surfaced one progressively-lower-stakes finding per round on FG-581 (fail-open rename → label accuracy → hard-coded `~/.forge` in code then docs → release-mode coverage). Lesson: it will keep finding "one more assertion"; a hard stop once the AC is genuinely proven is correct.

**Shipped (for reference):**
- **FG-581** (`dcc19ec`, PR #152) — fail-closed post-promotion RACI compile refusal: neutralizes a stale `routing-policy.yml` instead of warn-and-continue, names the rejected RACI construct verbatim (human + new `--json routingPolicyError` + repair), resolves all paths from `FORGE_HOME`, dry-run forecasts only. Docs `how-to-upgrade.md` reconciled. AC-evidence grid in the closed ticket. Required CI (`test` + `test-extended`) green.
- Follow-ups filed (non-blocking): **FG-601** (sanitize RACI-controlled compiler error before terminal render — escape-sequence hardening), **FG-602** (`startRun`/`invoke` accept a route-bearing run when host policy absent — pre-existing governance gap).
