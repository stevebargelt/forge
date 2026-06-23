**Last session ended 2026-06-22.**

**Where we left off:** Long session that shipped FG-350 (control-plane receipts) and FG-364 (pipeline fan-out request-changes deadlock), then answered a token-accounting question and filed FG-369. Pivoted off the FG-345 worktree epic at the user's call ("visibility first"): did FG-350 as the data foundation, then fixed FG-364 because the feature pipeline was untrustworthy for fan-out. Pipeline is now trustworthy for fan-out request-changes.

**Picked up next:**
1. **FG-349 — Control-Plane Sources** (dashboard EFFECTIVE config view). Next in the user's visibility ordering (FG-350 done → 349 → 348 → 359). Now runnable THROUGH the feature pipeline since FG-364 fixed the fan-out deadlock. Largely independent (reads live config, not receipts) — could even parallel FG-348.
2. **FG-348 — Dashboard Run Map + Explain** consumes the FG-350 controlPlane receipt shape; FG-359 — RACI Workbench (reuses existing governance query logic, least net-new).
3. **FG-351 — worktree lifecycle foundation** (FG-345 epic, all-agents worktrees) if returning to that thread; FG-351 is the no-dep entry point, FG-352-358 hang off it.
4. **Infra cleanup, all small:** FG-360 (backlog CLI retitle/reslug duplicate-file bug — bit us this session), FG-365 (receipt model-policy O(N+M) reads), FG-366 (outer runtime.name requested-vs-resolved), FG-368 (run.completed anyFailed:true on successful retry). FG-369 is a filed IDEA (dashboard token/cost visibility), not yet a story.

**External state to remember:**
- **OAuth token expired mid-session** and was re-logged-in via `forge auth login`. `forge auth status` reported "ok" the whole time because its health probe only checks the credentials FILE exists, not token validity (the FG-120 shallow-probe gap) — so a 401 inside agent containers is the real signal, not `auth status`. Watch for it.
- **~15 commits ahead of origin/main, UNPUSHED** (direct-to-main workflow; user has not said to push).
- **Untracked files in the tree that are NOT this session's** — likely other Claude/forge sessions: `backlog/ideas/FG-361`, `backlog/stories/FG-362`, `FG-363`, `FG-367`, `docs/prds/reducing-control-plane-complexity.md`, `research/gastown-forge-assessment.md`. Left untouched deliberately. Reconcile/commit or discard with their owner before they rot.

**Decisions worth not relitigating:**
- **Worktrees = all agents, always (FG-345).** Settled and designed; children FG-351-358 filed off an architecture pass. Do NOT re-narrow to "rw/blue only" (a prior handoff did; it was wrong). Cost is a non-factor; the value is converting silent races into detectable conflicts + a post-merge integration gate (FG-357).
- **FG-350 receipt shape:** manifest.json is authoritative (no SQLite columns); controlPlane block is ADDITIVE to the existing model/runtime block; EFFECTIVE (FG-349) vs RECORDED (FG-348) are separate read paths; receipts never fabricate provenance (unknown+warning, never silent "host"). FG-366 (outer runtime.name requested-vs-resolved) deliberately NOT bundled — architect boundary: the legacy runtime block has consumers (forge show, usage attribution).
- **You cannot dogfood the feature pipeline to fix a pipeline fan-out bug** — FG-364 was fixed via standalone quick-chain invokes, not `forge new feature`. Now that FG-364 is fixed, the pipeline IS usable for fan-out features again.
- **Deliver agent tasks via `forge invoke --task-file <path>`, NOT `--task -` stdin heredoc** — stdin delivery silently sent EMPTY tasks twice this session, the agent inferred work and no-oped while reporting complete. Burned ~2 rounds. Saved to memory. Always have the agent confirm receipt + verify the diff on disk; agents report `status: complete` even on an empty/ignored task and even when `tsc` fails (forge-test is tsx/transpile-only — run `npm run typecheck` on the host before committing).
- **Trim/retry a phase with `forge gate <id> request-changes`, never by hand-editing result.json.**

**Shipped (for reference; git log is canonical):**
- FG-350 control-plane receipts — dispatch-time provenance in every task manifest (invoke + pipeline + fanout children + reds); RECORDED-truth proven; accurate (red forceCount, concrete runtime name, validated docsSurfaces, mountMode rw/ro); legacy-safe; SCHEMA-CONTRACT.md + redaction.md updated.
- FG-364 — unwedged fan-out request-changes (dispatchFanoutStep selects the pending replacement primary; gate dedups to one pending primary; old parent kept as audit record with result; internal duplicate-wave guard; regression tests). Red-confirmed pass.
- Docs: reconciled stale src/spine → src/v2 references across README, how-tos, tech-lead seed, 6 ADRs, CLAUDE.md File layout.
- Filed: FG-345 reframed + worktree children FG-351-358; FG-347 (maintainer skips hand-authored CLAUDE.md); FG-360/365/366/368 (infra fixes); FG-369 (idea: dashboard token/cost visibility).
