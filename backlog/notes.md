**Last session ended 2026-06-24.**

**Where we left off:** Completed the test-tiering arc (FG-406 tiers → FG-408 unit-purity guard → FG-407 agent default). The last open thread is a NON-TICKET deploy step: FG-407's `docker/forge-test.sh` + seed-prose changes are committed but NOT yet live for agents.

**Picked up next:**
1. **DEPLOY FG-407 (non-ticket thread).** The new agent in-loop behavior is committed but baked, not live-from-source: run `scripts/install-seeds.sh` (seed prose → `~/.forge/agents/`) and `./docker/build.sh` (forge-test.sh → agent image). Until both run, dispatched agents still use the OLD full-suite default + OLD seed prose. User was mid-decision on whether to run these now or batch later. Both are machine-wide (image rebuild + overwrite ~/.forge/agents) — confirm before running.
2. **Decide on two untracked `docs/test-suite-assessment*.md`** — `test-suite-assessment.md` (my point-in-time suite assessment) + `test-suite-assessment-codex-review.md` (a review of it, authored externally — NOT by me). Options: commit as dated snapshots, fold the codex review's points into a follow-up, or discard. They're dated snapshots, so their stale counts/tier-as-future-work framing is intentional.
3. **FG-405** (coverage reporting) — complementary to the tiering arc and now well-set-up; the natural next backlog item. NOTE its ticket file is currently UNTRACKED (filed by another session, not yet committed) — verify with `forge backlog show FG-405` and commit/own it as needed.
4. **Campaign Runner Phase 1** (FG-390 data model, FG-391 planner) — UNBLOCKED now that Phase 0 is complete, but the user set a hard "no Campaign Runner implementation" guard this session. Pick up only on explicit go.

**External state to remember:**
- 20 commits unpushed (ahead of origin) — see final status line; user not yet asked to push.
- Orphaned `failed` forge run row `run-fg-408-purify-unit-test-tier-fea90a` — an FG-377 persistence-check FALSE POSITIVE (work shipped fine as 24dd3c7); harmless tracking artifact, reconcilable later.
- FG-407 deploy pending (see Picked-up #1) — the single most important "not live yet" fact.

**Decisions worth not relitigating:**
- **FG-398 lock = directory mutex** (`mkdirSync` atomic, holder marker = pid+timestamp), reclaim DEAD pids ONLY, NEVER steal a live lock (fail loud with manual-recovery message). The earlier 30s-age reclaim of a live holder was a real mutual-exclusion hole, removed per user. Concurrency MUST be validated on the HOST — the container could not reproduce the 1/40 race (overlayfs vs tmpfs scheduling).
- **Test tiering is by SUFFIX**, not directory (`*.test.ts` unit / `*.integration.test.ts` / `*.worktree.test.ts`). Convention-consistent, low-churn, glob-native for node:test. `src/test-tiers.test.ts` holds BOTH the partition-proof (tiers disjoint, union = full set) AND a unit-purity content guard (fails if a unit file spawns/execs/sleeps).
- **Unit tier must be semantically PURE**, not just suffix-correct — suffix split alone left git/subprocess/sleep tests in unit; FG-408 relocated init/upgrade/sso-watchdog/forge-test-detect-runner and added the guard. I over-claimed FG-406 "complete" before that; FG-408 closed the real AC.
- **`npm run test:all` (root + dashboard) is the shipped-claim gate**; unit-tier green is in-loop confidence only. Orchestrator runs the aggregate before completion.
- **FG-403/FG-404 were FG-397-review follow-ups**, filed rather than reopening closed tickets (the established pattern).

**Shipped (for reference):** FG-397 (atomic close/move + dup detection `f5b2b1d`) · FG-399 (`closed_commit` audit field `639ace3`) · FG-398 (concurrent-id lockdir, simplified semantics `1289619`) · FG-403 (listTickets all-dirs scan `de0b42a`) · FG-404 (file success-message subdir `425bf4e`) · FG-406 (suffix test tiers + partition proof `967baf5`) · FG-408 (unit-tier purity + content guard `24dd3c7`) · FG-407 (forge-test default → unit tier + seed/doc prose `060379a`) · Phase 0 marked complete in docs/campaign-runner-plan.md (`45c8969`). All closed with `--commit` audit shas. Host suite green at each step (aggregate 1838).
