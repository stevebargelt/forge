**Last session ended 2026-07-05 (session b).** Autonomous batch: FG-471 → FG-433 → FG-438. All three shipped, merged, closed.

**Completed (merged + closed):**
- **FG-471** (PR #34, `c18a8ee`) — reconciled the `awaiting_gate` notification docs with the code: gate pushes are ON by default (gates need operator action). Docs-only (code already correct); routed to the documentation-maintainer, which also annotated the PRD's historical intent. No review-loop (docs-only per policy). Gate campaign/ticket context was already delivered by FG-464 — verified.
- **FG-433** (PR #35, `92c101b`) — verified + tested the shipping-reviewer consumer side. `assembleReviewerContextPacket` already reads `run.metadata.ticketId` → resolves the backlog ticket + AC → done-audit; `runNext.ts` pre-fails the reviewer if ticketId absent. Added 2 producer→consumer integration tests (a campaign-driven run's metadata drives the ticket-aware preflight; and the negative — metadata is load-bearing). review-loop passed first run.
- **FG-438** (PR #36, `ce4de93`) — dashboard project cards link to their GitHub repo. New `src/util/github-url.ts` (`githubBrowserUrl` + `deriveGithubUrl`, git injectable); `ProjectRecord.githubUrl` populated dashboard-side only. review-loop had one fixer round that ADDED value: a 5-min TTL cache (avoids `git remote -v` per project every 2s poll — the ticket's own Notes concern) + extracted `dashboard/client/project-github-link.js` with tests + `dashboard/src/queries-projects.test.ts`. I reviewed the self-commits, ran the FULL `test:all` (root 3016 + dashboard 32, both green — the review-loop only runs root `npm test`, NOT the dashboard workspace tests, so I re-ran test:all myself), and re-verified the live browser render after the client refactor (17 cards, 10 GitHub pills, no-remote cards clean).

**Backlog delta:**
- Closed: FG-471, FG-433, FG-438.
- Opened: **FG-472** (threshold: requires a product decision) — a non-campaign `forge new feature` run has no `ticketId`, so the shipping-reviewer pre-fails and BLOCKS it (authoritative, per runNext.ts:819). Fail-safe but poor UX. Needs your call: add `forge new feature --ticket`, make shipping-reviewer conditional/skip-with-warning, or document. NOT decided unilaterally (hard-stop: product scope).
- Review residue intentionally NOT filed (below threshold): FG-438 round-2's note that main.js ProjectCard has no DOM test (no jsdom/bundler harness in the repo — reasonable tradeoff, the pure helpers ARE tested); the per-poll git cost was FIXED in-loop (cache), not deferred.

**Autonomous decisions (journal: notes/autonomous-session-2026-07-05b.md):**
- FG-471: keep code (awaiting_gate on-by-default per your recommendation), fix docs; skipped a DEFAULT_NOTIFY_ON code comment as disproportionate.
- FG-433: campaignId/itemId are populated but NOT consumed by the reviewer (ticket-keyed) — correct, no change. "forge new feature ticketId" → FG-472.
- FG-438: `githubUrl` derivation kept in the dashboard layer (not core `listProjects`) so `forge projects` CLI doesn't pay the git cost; the fixer's TTL cache further bounds the per-poll cost.

**Tests/reviews:** every merge gated on `npm run test:all` green (root + dashboard) + typecheck; review-loop for the two code changes (FG-433 clean; FG-438 one fixer round). Detached review-loop launcher used (`scratchpad/detach-run.py`); logs under scratchpad/reviewloop-*.log.

**Operational note (cost me ~20 min):** a backgrounded `until ! pgrep 'node --test'` wait-loop died silently (same signal that kills backgrounded waiters on this host) so I never got the test:all completion ping and sat waiting — the run had actually finished. LESSON: for the *final* wait, poll the log directly (`grep '^ℹ pass' <log>`) rather than trusting a backgrounded pgrep-waiter; or check `pgrep` + log mtime after a couple minutes instead of blocking on the notification.

**Blockers:** none. **Recommended next:** FG-472 (product decision — non-campaign feature ticketId); then FG-450 (dashboard "Forge Fleet in Motion" marquee, still reserved for your eye).

**FG-438 follow-up fix (PR #37, `825d8bb`):** operator found githubBrowserUrl() mistrimmed `repo.git/` (trailing slash + .git) → `repo.git` instead of `repo` — the .git$ anchor missed because the string ended in '/'. Fixed (trim slashes before .git) + combined-edge test (https/scp-SSH/ssh://). Reopened→fixed→re-closed. One-line correctness fix, gated on test:all green (3017+27), full review-loop skipped as disproportionate (recorded disposition).
