**Last updated 2026-07-28 (mid-session — decomposition review pending).**

**Where things stand:** FG-345, FG-623, and evidence-led review Change 0 are COMPLETE (recorded in
`backlog/PLAN.md`). The interim evidence-led review policy is ACTIVE as of `cc10232a` — both
authoritative sources (`docs/autonomous-run-prompt.md`, now git-tracked, and the orchestrator
seed/rendered CLAUDE.md block) agree, which is the PRD's activation condition. All review dispatches
now follow it: deterministic verification first, ONE risk-targeted discovery pass
(`review-loop --max-rounds 1` as transport only), manual finding ledger, disposition-before-fix, one
batch fixer, exact-ID recheck + delta-bounded discovery, absence-is-never-resolution. The old #302
phrase guard test was deleted (operator decision: it pinned superseded English, not behavior);
`orchestrator-block-parity.test.ts` remains the mechanical guard.

**Picked up next:**

1. **FG-608 (FG-496 Slice C)** — the next implementation item. The approved decomposition established
   no dependency displacing it.
2. **Evidence-led review decomposition APPROVED and FILED: FG-638 → FG-639 → FG-640 (strictly
   serial).** Operator amendments applied: PRD scenarios #2/#3/#10 live in FG-639 (FG-638 proves only
   persistence capability); FG-638 requires `duplicate` to cite its canonical finding ID and specifies
   the operator-authority mechanism (`--operator` flag → `decided_by: operator` + event, the existing
   gate/raci confirm pattern); FG-640 carries the REQUIRED FG-541 evidence mapping (local-only fixer
   commits, no silent publication of unrelated work, exact-head CI, trusted-tip equality). FG-541 is
   annotated folded-into/blocked-on FG-640 — superseded only when that mapping is durable.
   **Implementation NOT started — dispatch not yet authorized.**
3. **Non-ticket thread — rotate the leaked Docker Hub token** (carried from last session, still
   presumed unrotated). hub.docker.com → Account Settings → Personal access tokens. Do not file a
   ticket; do not lose it.

**Standing operator directives (this session):**

- **Do NOT dispatch FG-637.** It is deliberately deferred (PLAN.md deferred set); its position in a
  prior handoff list was not priority authorization. No further worktree/FG-637 coverage work without
  a deterministic supported-workflow failure.
- No further scope expansion of the Change 0 work; the historical prompt-text-test pattern gets
  assessed separately, not cleaned up piecemeal.

**External state:**

- **ntfy is still DOWN** — every `forge notify` this session failed `network: fetch failed` (Azure
  Container Apps host; TCP 443 never connects). Do not rely on push for unattended runs.
- **`~/code/forge-fg356`** (disposable clone) is synced to merged main `cc10232a`, clean, on `main`.
  All agent implementation work runs there (`--project`), never in `~/code/forge`.
- Dispatch contract reminders: isolation is default-ON on macOS (`FORGE_NO_WORKTREES=1` escape);
  project must be a clean committed git tree; `forge invoke`/`review-loop` against `~/code/forge`
  refuses (self-host) — use the clone.
- `forge ops check` shows 17 historical `orphaned_work_may_persist` incidents — known FG-549 noise
  (detector never clears); ignore unless one is recent.

**Decisions worth not relitigating:**

- The workspace contract (operator, 2026-07-28): committed tracked content at the recorded base SHA +
  explicitly supplied inputs; ambient local state intentionally not inherited. No generic carry-in.
- The macOS-only worktree gate is PERMANENT (DEC-004; "Linux" in those gates means the agent
  container). FG-358 closed out-of-scope.
- FG-345 is narrowed to managed workflow-dispatched agents; do not build invoke merge/publication
  machinery — the evidence-led review program owns that question.
- Change 0 is instruction-only BY DESIGN: no ledger tables, no coordinator, no new gates until the
  operator approves the Changes 1–3 decomposition.

**Shipped this session (for reference):**

- **FG-623** (`612e481f`, PR #172) — lease-renewal test moved off the 1 ms knife-edge to TTL/2
  (~150 s headroom, 0/400 probe failures, 50/50 isolated runs); closed with Acceptance Evidence grid.
- **Change 0** (`cc10232a`, PR #173) — interim evidence-led review policy on both authoritative
  sources + rendered block (byte-identical parity verified post-merge); `.git/info/exclude` entry for
  the autonomous-run prompt removed; stale `--max-rounds 2` example in
  `docs/how-to-use-forge-across-projects.md` corrected; obsolete phrase-guard test deleted.
- Watch item (not filed, n=1): one-off `ENOTEMPTY` cleanup race in `src/v2/docker-exec.test.ts:380`
  during an engineer container run; didn't reproduce across two subsequent full-tier runs.
