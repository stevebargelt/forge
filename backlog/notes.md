**Last session: FG-561 overnight autonomous run — 2026-07-17. TWO FG-572 children shipped; FG-580 decided (by another session).**

**Shipped + closed this session:**
- **FG-577** (Child 5a) — `forge upgrade` now resolves release-owned assets from the EXECUTING release, not the dev checkout. Merged `b5add06` (PR #126), closed `ae174cd`. Added `src/v2/asset-root.ts` as the single authority (assetRoot/executionMode/devCheckoutDir); inverted the `unresolved` default so a missed upgrade-state is a `tsc` error, not silent exit 0; fixed the seed-drift DETECTOR being env-subvertible via `FORGE_REPO_DIR` (the architect caught this — my FG-572 write had said "detection is already release-correct", which was wrong).
- **FG-578** (Child 5b) — `FORCE=1 install-seeds.sh` no longer clobbers operator-authored seeds. Merged `d9dacbb` (PR #127), closed `0802a77`. `AUTHORED_EXEMPT=(agents constraints raci)` are create-only/retained; policy enforced in the WRITER (install-seeds.sh), not the caller, because FORCE is a published operator contract. Two agreement gates pin mechanisms that can't share code (ownership + installer-cmp-vs-seed-drift-sameContent).
- **FG-587** — closed with FG-578 (its PRD supersession banners rode in on the branch).

**Picked up next:**
1. **FG-580 (Child 5g) — DECIDED by the operator (Option A: bundle dashboard into the promoted release), `eb5300d`.** Now the critical-path IMPLEMENTATION item — FG-572 can't close without it and FG-561's closeout gate holds on it. A **read-only current-main dashboard closure census** is in flight (its first AC) at session end — check `run-fg-580-*census*` result and record it on the ticket before implementing. Census facts confirmed at `0802a77`: dashboard UNCHANGED since `12b13c2` (workspaces:['dashboard'], node_modules 0B/hoisted, deps better-sqlite3+marked, `start: tsx src/server.ts`, NO build step). Contract: bundle dashboard/src+client+pkg-metadata into the release closure, resolve from `assetRoot()` (FG-577's pattern), commit-bind it (dirty dashboard tree refuses build), retire the `dashboard.ts` release-mode refusal only after it works, browser-smoke against a real promoted-release fixture. Large — treat as its own architecture-led effort.
2. **FG-579 (Child 5c+5d)** — seed-drift omits `workflows` + conflates ownership with coupling-severity; a stale workflow mis-runs silently, needs a named refusal on the CONSUMING path. Unblocked, medium.
3. **FG-581 (Child 5f)** — post-promotion RACI compile failure only warns (`upgrade.ts:176-179`), leaving the previous runtime's routing-policy.yml silently authoritative. Escalate to a named refusal. Small, unblocked, directly continues the RACI surface.
4. **FG-583 (Child 5h)** — host seed install is a non-atomic cp-loop; an interrupted upgrade can expose a mixed-but-Zod-valid workflow set to a concurrent `forge next`. Medium. Touches install-seeds.sh (coordinate with FG-578's landed changes).
5. **FG-582 (Child 5e)** — BLOCKED on the operator's T9 hook-anchoring decision (installed pointers: symlink-through-`current` vs pin-at-install). Also owns two stale slash-command-symlink docs (concepts.md:40, quick-start.md:80).

**Defects Forge revealed in its own machinery (filed this session):**
- **FG-584** — feature build fanout can't sequence interdependent plan steps; file-disjoint ≠ independently typecheckable. Forced a plan→one-step collapse on BOTH FG-577 and FG-578. Options recorded (teach tech-lead / validate at plan gate / real dependency waves); needs an arch pass.
- **FG-585** — a feature run whose verify phase FAILS reports `status: complete` while its gate:auto docs phase silently never runs. False completion, wrong-ship class. Probable FG-477 slice.
- **FG-586** — a stray leading `+` on a red's result.json silently downgraded an authoritative `fail:0.98` + a shipping-reviewer `needs_fix` to inconclusive/failed. Wrong-ship vector IN the review pipeline. Fix directions: bounded envelope-strip before JSON.parse; fail-closed on a malformed AUTHORITATIVE red.

**Operational lessons (worth keeping):**
- **Grep the PREMISE, not the phrasing, file-level across the WHOLE corpus, BEFORE the first review** — a rule change ("don't clobber authored seeds") was stated ~15 ways across README/how-tos/PRDs/seeds/backlog/code-comments; the review-loop found ONE per round for SIX rounds because I fed it piecemeal. Saved to memory ([[feedback_premise_grep_whole_corpus_on_rule_change]]). On the NEXT rule-change ticket, do the comprehensive premise sweep up front.
- **When a correction is mechanical, hand over the ARTIFACT (exact file list), not a description** — FG-578's plan took 4 rounds because I described a file list and the tech-lead invented a phantom path + dropped two proof-tests. Pasting the exact tree-verified list fixed it instantly.
- **The reviewed-tip EQUALITY gate (FG-514) fires on ANY main movement** — another session's backlog commits to main diverged my open branch THREE times, each forcing a rebase. Legit to merge on `diverged` ONLY after PROVING the divergent commits are disjoint (zero file overlap) AND branch-protection strict=false — that's the loop's "re-evaluate before closing", verified not assumed. Did this for FG-578's merge.
- **A closed PRD an operator still consults is LIVE guidance** — don't defer a now-broken checklist step as "historical record"; the test is "would an operator following this exact step today get broken behavior?"

**External state / containment:**
- **Promotion NEVER activated on this host, by design.** `~/.forge/{current,releases,interpreters}` absent; host RACI untouched since Jul 12 (the file FG-578 protects). No `npm link`, no `forge init`/`upgrade` run.
- **`~/code/forge-fg571` is the standalone writer clone** for this campaign — synced to origin/main between tickets, branch-per-ticket. Reusable.
- **Another orchestrator session is active on the operator's behalf** — it filed FG-588 and made the FG-580 decision on main. Coordinate: two sessions on the same main cause branch divergence (see the rebase lesson). Check `forge status` for its runs before starting a child it might grab.
- main clean/synced at `0802a77` (or later if the FG-580 census landed + was recorded).

**Decisions worth not relitigating:**
- FG-580 is Option A (bundle), settled by the operator — do NOT reopen; a new build step changes the implementation contract, not the decision.
- FG-577's threat boundary is settled (same-UID `$FORGE_HOME` write = accepted honest limit; no chmod/permission machinery; no version marker; content-addressing is the one identity mechanism).
