**Last session ended 2026-07-17.** ⚠️ **RECOVERY MODE IS STILL ACTIVE — FG-561 automatic advancement remains PAUSED.** The governor below was never lifted; it still governs the next session.

**Where we left off:** Under an explicit operator go, this session took ONE bounded ticket end-to-end — **FG-586 shipped and closed** (fail-closed on unreadable authoritative reviewer output) via engineer → test-engineer → bounded review-loop (2 rounds) → merge → close → a narrow docs-impact reconciliation. Then, as a separate operator-authorized bounded change, **de-duplicated PR CI runs** (`.github/workflows/ci.yml` push trigger scoped to `main`). Nothing is mid-flight; nothing auto-resumes.

**RECOVERY GOVERNOR (operator, 2026-07-17 — DO NOT DROP):** No new ticket or AC may be created from a finding unless it directly falsifies an existing accepted acceptance criterion or demonstrates credible in-scope data-loss/security harm. Optional hardening is deferred by default. Product properties, new test environments, dependency policies, and required CI gates require explicit operator authorization. Campaign health is measured by **net open-backlog reduction**. Do not dispatch agents/pipelines/review-loops or start implementation children without an explicit operator go.

**Picked up next (NONE auto-starts — all gated on explicit operator go):**
1. **FG-579 is the next functional campaign blocker** — a CURRENT silent workflow-misrun path (seed-drift omits `workflows`, so a stale installed workflow mis-runs undetected). Must not start without a separate explicit operator go. Completing it must NOT auto-dispatch FG-581/582/583/585.
2. **FG-585 (kept, active, not started)** — a run reports `status: complete` while its gate:auto docs phase silently never ran (false completion). Sibling orchestration-integrity defect to the just-shipped FG-586; do NOT fold the two together (operator kept them separate). Fix direction unresolved — decide at start.
3. **Deferred FG-572 promotion-path children:** FG-581 (post-promotion RACI compile only warns), FG-582 (hooks anchoring — T9 decided = symlink-through-`current`), FG-583 (non-atomic cp-loop install → mixed workflow set). Valid but not current failures (promotion never activated on this host).

**External state to remember:**
- **Operator working-preference set this session: use Monitor (condition-driven, emits on terminal state), NOT ScheduleWakeup fixed timers, to wait on launched work** ("wakeups waste time"). Pattern used all session: `forge launch run` owns the work; a Monitor polls durable launch status / CI checks and fires once on terminal state. Recorded in memory `feedback_schedulewakeup_not_sleep_for_waits.md`.
- **CI is now de-duplicated (f2fc251):** a PR-branch push runs exactly ONE `test` + ONE `test-extended` pair via `pull_request`; a push/merge to `main` runs one pair via `push`. Required branch-protection contexts unchanged (`test`, `test-extended`).
- **`~/code/forge-fg571` is the standalone writer clone** — used for all three PRs this session; currently left on local branch `ci-dedupe-pr-push-triggers` (its remote branch was merged+deleted). Sync to origin/main and branch fresh before reuse.
- **Promotion NEVER activated on this host, by design.** `~/.forge/{current,releases,interpreters}` absent; host RACI untouched. Real host never promoted.

**Decisions worth not relitigating:**
- **FG-586 fix = fail-closed on unreadable authoritative reviewer output.** Recovery-by-stripping is a bounded nice-to-have (single leading `+`/`-` byte, ```json fence — no first-`{` salvage); the load-bearing invariant is that an unreadable AUTHORITATIVE result BLOCKS (`blocked_by_red`) with a named finding, never advances. `model_error`/infra failures stay non-blocking. Two mutation guards lock it (revert-Part-B → red; arbitrary-prefix salvage → red). Settled; don't re-open the design.
- **CI trigger change was trigger-only** (added `branches: [main]` under `push`). Branch protection NOT touched; job definitions/commands/names/concurrency/Node/deps all unchanged. No ticket filed (operator directed no backlog item).
- Prior-session settled calls still standing: FG-580 offline code KEPT (`b6c6542`, do not revert); FG-584 & FG-589 WITHDRAWN (do not resurrect); FG-580 Option A (dashboard bundled) settled; FG-577 same-UID `$FORGE_HOME` write = accepted honest limit.

**Shipped (for reference):**
- **FG-586** — fail-closed on unreadable authoritative reviewer output; Part A bounded envelope strip + Part B fail-closed block generalizing the FG-420 ingestion-time block; 11 real-path tests + 2 mutation guards (`251fa6d`, PR #129). Closed against merge SHA (`d3e72aa`).
- **FG-586 docs-impact** — `docs/concepts.md` "Blocked by red" enumeration corrected Two→Three conditions, added the unreadable-authoritative block (`ad4110e`, PR #130).
- **CI PR-run dedup** (non-ticket, operator-authorized) — `.github/workflows/ci.yml` push trigger scoped to `main` (`f2fc251`, PR #131).
