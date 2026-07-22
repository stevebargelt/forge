**Last session ended 2026-07-22.**

**Where we left off:** FG-581 (FG-572 Child 5f — post-promotion RACI compile-failure refusal) shipped + closed (squash-merge `dcc19ec`, PR #152), driven end-to-end. No open thread mid-flight.

**What FG-581 changed:** `forge upgrade` no longer warn-and-continues when the promoted runtime can't compile the installed operator-authored RACI. At the single compile-failure site in `runUpgrade` (`src/cli/commands/upgrade.ts`) it now neutralizes the previous runtime's stale `routing-policy.yml` **fail-closed** — quarantine (`.quarantined`) → `unlink` fallback → if both fail, keep `routingPolicy='failed'`, append the error, and loudly tell the operator it's STILL authoritative (remove by hand). Names the rejected RACI construct verbatim (human warning + new `--json UpgradeResult.routingPolicyError` + repair guidance), all paths resolved from `FORGE_HOME` (not hard-coded `~/.forge`). Dry-run forecasts, mutates nothing; success/no-raci paths unchanged. Docs: `how-to-upgrade.md` reconciled. AC-evidence grid recorded in the closed ticket.

**How it went (for pattern-awareness):** full `implementation_full` pipeline (architect caught the key correction — the exit-1 refusal already existed; the real defect was the persistent on-disk artifact) + bounded review-loop. The red-wide reviewer surfaced ONE progressively-lower-stakes finding per round: fail-OPEN rename (fixed), stale-reason label accuracy (fixed), hard-coded `~/.forge` in code then docs (fixed), then release-mode acceptance coverage. Operator authorized ONE test-only exception to add a promoted-`mode:"release"` acceptance test; the final finding (release-mode `--json`/construct assertions) was dispositioned as duplicative of already-proven mode-agnostic dev-mode coverage → FG-603. Lesson: red-wide will keep finding "one more assertion"; a hard stop after the AC is genuinely proven is correct.

**Picked up next:**
1. **FG-572** now open on only **FG-582** (5e — installed git hooks anchoring, carries the T9 tension; decision leans symlink-through-current) and **FG-583** (5h — non-atomic seed cp loop; depends on FG-577, landed). Closing both closes FG-572 → closes epic **FG-561**.
2. **FG-599** — durably record normal-delivery + replay-recovery (positive Q2 delivery-mode record).
3. **FG-600** — FG-565 follow-ups (`forge continuation` should not `ensureForgeDirs`; F21 should drive the real `forge cancel` CLI).

**Follow-ups filed this session (all non-blocking, from FG-581 review):**
- **FG-603** — release-mode `--json`/verbatim-construct assertions on the promoted-release acceptance test (test-only; duplicative of mode-agnostic dev-mode coverage).
- **FG-601** — sanitize RACI-controlled compiler error before terminal render (escape-sequence hardening; fail-safe).
- **FG-602** — `startRun`/`invoke` accept a route-bearing run when the host policy is absent (pre-existing governance gap, broader than the upgrade site).

**External state to remember:**
- Writer clone `~/code/forge-agent-work`: on branch `feat/fg581-post-promotion-raci-refusal` (merged as `dcc19ec`, branch NOT deleted). `git reset --hard origin/main` before next use.
- Control checkout `~/code/forge` is the LIVE npm-linked control plane; promotion is NOT in force here, so writing agents ALWAYS use the standalone clone, never `main`. Read-only reviewers may mount `main` RO.
- PR #152 branch left undeleted on GitHub.

**Decisions worth not relitigating:**
- FG-581's fix is artifact-neutralization (fail-closed), NOT message-tweaking — the exit-1 refusal machinery pre-existed. The discriminating RED test asserts stale-policy NON-consumption on disk, not exit status.
- The release-mode path is mode-agnostic for FG-581 (Step-3 recompile runs regardless of mode; `mode` only gates Steps 1-2 dev-advancement). Dev-mode tests exercise the identical logic; the release-mode test proves the release path reaches it. FG-603 covers the residual assertion-matrix duplication.
