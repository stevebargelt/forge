**Last session ended 2026-07-02.**

**Where we left off:** Wrapped campaign-922c83b7c577 end-to-end (FG-357, FG-376, FG-422 all shipped) and — on the user's explicit direction — left it PAUSED (not abandoned) as preserved live evidence for the campaign-enhancement work. FG-422's item sits at awaiting_gate because its real deliverable (skills authoring) was re-routed to the docs lane, out of the feature pipeline.

**Picked up next:**
1. Campaign-enhancement tickets, mining campaign-922c83b7c577 as the live reference case. Priority order: FG-443 (COMPLETE an out-of-band/re-routed item + first-class docs/authoring lane — most directly unblocking the stuck FG-422 item) → FG-440 (auto post-merge host-verification capture so reconcile doesn't need a manual record) → FG-441 (resume should reconcile manually-driven item runs after merge/close) → FG-442 (planner routes each item into an execution lane instead of defaulting to full feature). FG-427 (honor recorded force-advance / later pass over stale red-fails) underpins the reconcile behavior these depend on.
2. FG-435 — profile-scoped STS staleness detection + profile-named message. This bit the user on their WORK LAPTOP this session (multi-profile false positive: global detection flagged the wrong profile). Design is understood; fix is scoped.
3. Remaining FG-376/FG-428 follow-ups: FG-434 (operator prune command for shared dependency-cache volumes), FG-437 (AWN-1 crash reconciler for the provisioning phase), FG-431 (reconcile low-sev polish: inconclusive-supersession label + project_dir canonicalization), FG-433 (populate run.metadata.ticketId so shipping-reviewer preflight can run).

**External state to remember:**
- campaign-922c83b7c577 is INTENTIONALLY paused as evidence — do NOT abandon or clean it up (project memory project_campaign_922_preserved_evidence records why). It demonstrates the FG-440/FG-441/FG-443 gaps concretely: FG-357 recovered via reconcile; FG-376 only reconcilable after a MANUAL `forge record-host-verification`; FG-422 stuck at awaiting_gate with no clean "complete" path.
- Work-laptop STS false positive (bedrock/SSO): immediate unblock is `aws sts get-caller-identity --profile <the-specific-stale-profile>` — with MULTIPLE aws profiles, forge's detection is global and names the wrong profile. Real fix is FG-435. (Note: for a pure-SSO profile that never writes ~/.aws/cli/cache, deleting ~/.aws/cli/cache also clears the false positive.)
- install-seeds.sh now ALSO installs the forge-* workflow skills to the user-global Claude skills dir (~/.claude/skills, override CLAUDE_SKILLS_DEST/CLAUDE_CONFIG_DIR) — a single install makes them available in every project.
- Docker Desktop went down mid-session and was restarted; agent invokes (forge invoke/new) need it running.

**Decisions worth not relitigating:**
- FG-376 shared dependency cache = TWO-PHASE provision-then-run: a dedicated short-lived provisioner container (repo ro, volumes rw) installs under a short host lock and writes a ready marker atomically; the real agent/reviewer then mounts the volumes READ-ONLY. Lock scoped to the provisioner only; a dead-pid lock is stolen ONLY after the recorded provisioner container is CONFIRMED gone (kill returns killed/not_found, never on an unconfirmed error). Do not revert to a whole-run lock or time-based stale-lock theft. Crash-recovery of the provisioning phase is deferred to FG-437.
- FG-422 skills authored via documentation-maintainer (durable-docs lane), NOT engineer/test-engineer — re-routed after the architect gate; the campaign runner can't express a docs-only lane (that's FG-442/FG-443). Distributed via seeds/skills → ~/.claude/skills; NO plugin (deferred, "maybe one day"). forge-review-loop points to the shipping-reviewer seed as source of truth rather than forking reviewer discipline.
- FG-376 campaign item was recovered by MANUAL `forge record-host-verification` (genuine `npm run test:all` green on the merge commit) then `forge campaign reconcile` — this is the sanctioned evidence path, not hand-patching. The missing auto-capture is FG-440.
- install-seeds.sh idempotency: macOS BSD `cp -n` exits 1 when it skips existing files, so under `set -euo pipefail` every RE-RUN aborted; fixed with a copy-if-absent helper (preserves local edits, FORCE=1 overwrites, real errors still surface).
- Blocked-by-red fix flow used repeatedly: single non-fanout `forge invoke engineer --run <run>` fixer (NOT request-changes, which re-runs the fanout), then advance --force with documenting rationale, then a focused red-wide re-check before close. "Work not persisted" on these fixers was consistently the FG-377 macOS false positive — work verified on disk each time.

**Shipped (for reference):**
- FG-357 — recovered from a stale-red-fail campaign wedge via evidence-gated reconcile.
- FG-428 — evidence-gated, non-destructive campaign reconcile command (PR #4, merge 6a9c713).
- FG-376 — agent worktree dependency parity / shared lockfile-keyed cache with two-phase provisioner (PR #5, merge 7211a47).
- FG-422 — four forge workflow skills (forge-campaign/review-loop/backlog/research-synthesis) + ~/.claude/skills distribution + install-seeds idempotency fix (PR #6, merge 53784a4).
