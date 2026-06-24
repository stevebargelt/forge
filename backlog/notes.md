**Last session ended 2026-06-23.**

**Where we left off:** Drove the worktree arc (FG-345 children) end-to-end: FG-351 → FG-354 → FG-352 → FG-353 all shipped and hardened. Opt-in worktree mode (`FORGE_WORKTREES=1`, default OFF) is now functional for BOTH sequential single-primary and concurrent fan-out, no-discard-safe throughout. Last act: you decomposed FG-372 (Shipping Reviewer) into an epic + stories FG-381..FG-386. Everything committed AND pushed; tree clean.

**Picked up next:**
1. **FG-376 — Agent worktree dependency parity** (real node_modules in worktrees). The biggest practical blocker to worktree mode being usable: without it agents can't run `forge-test` inside a worktree. The FG-351/352/353 work deliberately left this seam open (no npm install in any worktree path).
2. **FG-357 — Post-merge integration gate** (build+test the MERGED result). Small and ready: the seam comment is already in place in BOTH `dispatchSingleStep` (FG-352) and `dispatchFanoutStep` (FG-353) — "FG-357 seam: post-merge build+test integration gate goes here". Drops straight in.
3. **FG-379 — worktree operator docs** stays deferred until worktree mode is production-ready (FG-376 + FG-357). Don't write operator-facing worktree env-var docs before then — they'd document a knob that false-fails until those land.
4. Remaining worktree children: **FG-355** (single-primary red snapshots — dispatchSingleStep, the counterpart to FG-353's fan-out red mount), **FG-356** (orphan worktree cleanup in reconcile), **FG-358** (Linux node_modules provisioning).
5. Off-arc backlog that pre-dates this session: **FG-377** (persistence-check macOS false-positive — highest-impact infra), **FG-348/349** (dashboard visibility thread).
6. Non-ticket thread: the new Shipping Reviewer epic (FG-372 → FG-381..386) is filed but unstarted — it's design/planning work, not queued for implementation yet.

**Decisions worth not relitigating:**
- **Worktree mode defaults OFF** — explicit opt-in `FORGE_WORKTREES=1`; `FORGE_NO_WORKTREES=1` is a true kill switch (short-circuits `isWorktreeModeEnabled`, does NOT weaken gates). Cleanup test-mode is `FORGE_WORKTREES_EPHEMERAL=1` (NOT the old "DORMANT" name).
- **runContainer keeps the `projectDir` vs `worktreePath` distinction** — ONLY `PROJECT_DIR` (runNext.ts:1411) resolves to the worktree; never replace `args.projectDir` globally (it feeds runtime/auth/model-policy/manifest — ~10 consumers).
- **No-discard invariant is load-bearing and was violated twice** (both caught post-ship): FG-352 auto-commit catch-all could merge-as-success then delete unmerged work (fixed: `git status --porcelain` gate, commit-fail→ok:false+retain); FG-353 cleanup blindly proven-merge-cleaned ALL children (fixed: only `status===complete` children cleaned, failed retained). Any new git-mutation-feeding-cleanup path needs the same scrutiny.
- **Forced red-override re-entry must COMPLETE regardless of gate type** (FG-353 fix): the gateForced re-entry path completes the parent directly, NOT via `finalizePrimary(step.gate)` which would re-gate verdict/human. The canonical feature workflows are all `gate: verdict` fan-out builds — test the verdict/human path, not just `gate: auto`.
- **All forge-owned git commits/merges set explicit identity** `-c user.name=forge -c user.email=forge@local` (don't depend on host/project git config).
- **FG-372 is now an epic** (promoted from story this session), broken into FG-381..386.

**External state to remember:**
- The TypeScript dep is declared `^5.6.3` in package.json but the committed lockfile resolves it to 5.9.3 (floats within the caret range). A FG-353 agent once bumped the declared floor to `^5.9.3` (a no-op, reverted) — don't be alarmed if `tsc --version` reports 5.9.3; that's the locked resolution, not a contamination.
- The no-env-fabrication / anti-shim policy caught a real production test backdoor this session (a FORGE_TEST_INTEGRATION_THROW hook smuggled into worktree-lifecycle.ts to make a test pass) — it was rejected and rewritten to a real failure induction. `forge check-agent-diff` + reds remain the backstop; keep using them on lifecycle/git/durable-state changes.

**Shipped (for reference):** FG-351 (worktree lifecycle foundation, opt-in/default-off) · FG-354 (persistence-check validates under worktreePath) · FG-352 (single-primary --ff-only merge-back + no-discard auto-commit fix) · FG-353 (fan-out integration: ordered child merges → integration branch → integrated red mount → integration→HEAD post-gate, + forced-re-entry gate-type fix). Filed: FG-379 (deferred worktree docs), FG-380 (host-local operational state — yours), FG-372 epic + FG-381..386 (Shipping Reviewer breakdown — yours). Full host suite 1771/1771 green at session end.
