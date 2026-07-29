**Last session ended 2026-07-29.**

**Where we left off:** The live forge-repo cutover (Phase 3) is PARKED at a genuine shipped gap: `forge
backlog migrate` refuses over the target project's active runs, but the predicate counts ORCHESTRATOR
SESSION rows (`run-orchestrator-*`) — so forge-on-forge can never migrate, since the session driving the
migration always blocks itself. The architect's accepted default was refuse-WITH-override; the override
half never shipped. The operator declined to dispatch the fix this session ("no need"). The dry-run
otherwise validated: 597 tickets, correct one-way UX, DB untouched.

**Picked up next:**

1. **Cutover unblock — needs an operator decision first.** The right fix (argued and not disputed):
   correct the migrate in-flight predicate so workflow/campaign runs block hard but orchestrator
   session runs don't (they have no step pipeline to split truth across; reads re-resolve mode via the
   3s cache), with a regression test each direction. That is FG-608 scope vs an accepted plan default —
   reopen FG-608, fix, re-close, then the operator re-runs `forge backlog migrate`.
2. **FG-645 — zero-red tranche 2** (63 in-container spawned-CLI integration reds, ONE root cause: the
   agent container's own authority marker leaks into spawned `forge backlog` CLIs). Mechanical ~15-file
   sweep; the repair pattern already ships in-repo (`src/backlog/container-authority.testkit.ts`
   preload). Also fold in: `docker/verify-launch-tier-in-image.sh` still requires a committed checkout
   (constraint recorded, change unshipped because the authoring container had no docker).
3. **FG-646 — migrate `--dry-run` writes `project_key` into `.forge/config.yml`** despite printing
   "nothing was written" (half-claims identity on any probed project). Live evidence: the forge repo's
   `.forge/config.yml` is sitting UNCOMMITTED in the tree with exactly that line — left deliberately as
   the defect artifact; the real migrate wants that line anyway, so commit-or-keep is a small call at
   fix time.
4. After the cutover decision: **FG-609** (FG-496 Slice D) is the next implementation item per PLAN.
   FG-638 → FG-639 → FG-640 (evidence-led Changes 1–3) are filed, approved, and NOT started — dispatch
   not yet authorized.
5. **Non-ticket thread — rotate the leaked Docker Hub token** (carried since 2026-07-28, still presumed
   unrotated). hub.docker.com → Account Settings → Personal access tokens.

**External state to remember:**

- **ntfy still DOWN** (every `forge notify` fails `network: fetch failed`). No push for unattended runs.
- **`~/.forge/forge.db.pre-fg608.bak`** (280MB) is the machine-wide restore point taken before the
  FG-608 schema wave; the parity-guarded migrations have since applied cleanly (tickets.imported_from
  verified present).
- **Agent image was rebuilt** this session (d66e324ac4f7) and now ships the in-container backlog reader
  — an image rebuild is a MANDATORY cutover prerequisite on any other host (documented in
  docs/how-to-backlog-db-cutover.md).
- `~/code/forge-fg356` (clone) is on merged main, clean. Two stale orchestrator-session run rows
  (bf2fa4 = the ended session, 085fdf from 07-16) remain `active` in the DB — no liveness signal
  exists; do NOT cancel by age.

**Decisions worth not relitigating:**

- **ZERO-RED RULE (operator, stated twice with force):** red tests are never a tax — they stop
  EVERYTHING, promoted ahead of all feature work. And zero-red means DETERMINISTIC TESTS THAT EXECUTE
  everywhere they claim coverage — converting failures to skips is a horrific precedent; a skip is
  never evidence; `not_executed`/`blocked_environment` over false green; claimed alternate coverage
  must name lane + candidate SHA + executed assertion. Persisted in
  memory (feedback_all_tests_pass_always), FG-644's closed record, FG-639's AC, and the evidence-led
  PRD. Do not re-derive; do not soften.
- **Interim evidence-led review (Change 0) is ACTIVE** — both authoritative sources agree since
  cc10232a. One discovery pass, manual ledger, disposition-before-fix, ONE batch fixer, exact-ID
  recheck + delta-bounded review. It was exercised end-to-end on FG-608 and works.
- **FG-637 stays deferred** (operator: its handoff-list position was never priority authorization);
  no worktree/isolation coverage work without a deterministic supported-workflow failure.
- **docker-exec ENOTEMPTY (n=2 sightings total) stays on WATCH** — no retry without a demonstrated
  race mechanism (operator explicit).
- **FG-541 is folded into / blocked on FG-640** — superseded only when FG-640's evidence mapping is
  durable, never merely because it was filed.
- The migrate predicate fix was NOT dispatched this session by operator instruction — parked, not
  forgotten (see Picked up next #1).

**Shipped (for reference):**

- **Change 0** (`cc10232a`, PR #173) — interim evidence-led policy on both authoritative sources;
  obsolete #302 phrase guard deleted; `docs/autonomous-run-prompt.md` now tracked.
- **FG-623** (`612e481f`, PR #172) — lease-test knife-edge fixed, closed on AC walk.
- **FG-608** (`f9afbf59` PR #174 + `935bea1` PR #175) — full Slice C machinery (dashboard DB truth,
  container ticket authority, atomic migrate/reidentify, removal reconciliation) shipped through the
  complete pipeline (17 red findings dispositioned, real-container acceptance on the rebuilt image),
  then reopened for the live-host migration gap and re-closed with the fresh-vs-migrated parity guard
  (54 missing ALTERs; mutation-tested).
- **Zero-red tranche 1** (`9623a704`, PR #176) — FG-644 + FG-556 + FG-557 closed: release/fg612 suites
  execute from dirty trees against candidates carrying in-flight changes; execution-identity
  regression (caught CI's missing global tsx on its first outing); host worktree tier now
  **435 pass / 0 fail / 0 skipped**.
- **Filed:** FG-638/FG-639/FG-640 (evidence-led decomposition, approved with amendments), FG-642
  (dark browser tier), FG-643 (dashboard sanitizer), FG-645 (tranche 2), FG-646 (dry-run write).
- Backlog/PLAN reconciled throughout; FG-638 carries the --operator authority caveat; the other
  session's housekeeping pass merged with the ADR-028/029 collision resolved.
