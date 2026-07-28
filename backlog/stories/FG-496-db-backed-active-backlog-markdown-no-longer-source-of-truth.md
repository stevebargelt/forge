---
id: FG-496
type: story
status: active
title: "DB-backed active backlog: stop using git-tracked markdown files as the live work-queue source of truth"
created: 2026-07-07
---

## Problem

Forge's active backlog is currently represented as git-tracked markdown files under `backlog/`. That has become unreliable as Forge now runs campaigns, review-loops, detached agents, and isolated worktrees:

- A new ticket can exist only as an untracked local file, so another Forge worktree or clean checkout says the ticket does not exist.
- Review-loop tree restore, stash/reset flows, or branch switches can discard or hide backlog intent.
- Filing/editing/closing backlog items dirties the project repository even when the change is operational coordination, not product code.
- Campaigns and autonomous runs depend on whichever checkout's `backlog/` files they happen to see.
- Handoff/orient can report stale or incomplete backlog state because the live queue is split across git files, local dirtiness, and pushed state.

Recent concrete example: FG-495 was visible in the current working tree but untracked. `forge backlog show FG-495` worked locally, while another Forge run/worktree correctly reported that FG-495 did not exist until the file was committed and pushed.

The same split can happen after dispatch. During FG-628, AC 5 was amended and committed in the live checkout
while the implementation agent worked in a disposable clone. Inside the container, `forge backlog show FG-628`
correctly read that clone's older Markdown snapshot and could not see the amendment. The task package happened
to carry the widened invariant, so that run was not harmed; a brief that only said "read the authoritative
ticket" would have been stale.

Git-tracked markdown is useful for migration, audit, or optional human-readable snapshots, but it is a poor live coordination store.

## Goal

Move Forge's active backlog/work queue to Forge DB-backed storage. The DB becomes the source of truth for backlog CRUD, campaign planning, review-loop ticket lookup, autonomous runs, and dashboard backlog views. Markdown backlog files become legacy/import compatibility only, not the required runtime representation.

## Acceptance Criteria

- `forge backlog file`, `edit`, `close`, `show`, and `list` operate on DB-backed tickets, not on `backlog/*.md` files as the source of truth.
- Backlog CRUD works in a project with no `backlog/` directory present.
- Existing repo-backed markdown backlog files can be imported/migrated into the DB with at least id, type, status, title, body, created date, closed date, relations, and relevant frontmatter preserved where present.
- Tickets have an explicit `type` field in the DB schema, not just a directory convention. Initial supported types include at least `bug`, `story`, `epic`, and `idea`, with room for future workflow-specific types.
- Existing markdown imports preserve the current file/frontmatter-derived type (`story`, `epic`, `idea`) and can map future bug files or imported external issues to `bug`.
- Campaign planning reads ticket definitions from the DB-backed backlog.
- Review-loop and shipping-reviewer ticket lookup read from the DB-backed backlog.
- Autonomous runs and handoff/orient read the same DB-backed backlog state across Forge worktrees.
- Containerized agents read the same live DB-backed ticket authority as the host even when their mounted
  checkout or clone contains stale or absent `backlog/*.md`.
- Agent access to the backlog authority is read-only, project-scoped, and backlog-only. A container cannot
  mutate tickets, read another project's tickets, or inspect unrelated host control-plane tables merely
  because it needs `forge backlog show`.
- Dashboard backlog views read from Forge's DB/API, not by scanning markdown files.
- Filing, editing, or closing a backlog item no longer dirties project `git status` by default.
- The CLI surfaces the active backlog storage mode clearly during migration, so operators can tell whether they are still reading legacy markdown or the DB store.
- Migration is idempotent: re-running import does not duplicate tickets or lose newer DB edits without an explicit conflict decision.
- Tests cover the FG-495 shape: create a ticket, then read it from a clean secondary worktree/checkout where no markdown file exists; Forge still finds it through the DB-backed store.
- Tests cover a project with no `backlog/` directory: backlog CRUD, campaign planning, and dashboard/API listing still work.
- Tests cover the FG-628 mid-run amendment shape: after a container has started from a stale clone, a host DB
  edit to its ticket becomes visible to a subsequent `forge backlog show` in that same container, while the
  task's originally bound ticket revision remains recorded for audit.

## Non-Goals

- Markdown export is not required for the first cut. If human-readable snapshots are wanted later, make export an explicit optional command.
- This story does not solve multi-machine remote synchronization beyond the existing Forge DB/host model. It must make same-host multi-worktree behavior reliable first.
- This story does not move operational handoff/orient/session notes; FG-380 owns host-local operational state. This story owns active backlog/work-queue source of truth.
- This story does not require GitHub Issues or Jira integration.

## Design Notes

Suggested model:

- `tickets`: id, type, status, title, body, priority/order fields, created_at, updated_at, closed_at, source/import metadata.
- `ticket_events`: append-only ticket lifecycle events for file/edit/close/import/migration.
- `ticket_relations`: blocks, related, parent/epic, discovered-from, supersedes, or similar relationships.

Important product decision already made: do not make markdown export a core requirement. The dashboard needs to show backlog items, but it should do that through Forge's DB/API.

### Container ticket authority (binding decision, 2026-07-28)

DB cutover is not safe until containerized agents can read authoritative tickets. The access surface must have
all of these properties:

- **Live:** a host edit committed after container start is visible on the container's next backlog read. A
  dispatch-time Markdown or DB snapshot alone does not close the FG-628 failure.
- **Read-only at the boundary:** backlog mutation commands from an agent container refuse, and the mounted
  storage itself is not writable. Prompt instructions are not the write boundary.
- **Project-scoped and backlog-only:** do not mount `~/.forge/forge.db` wholesale. It contains other projects
  and unrelated run/task/event control-plane state. Expose a dedicated per-project backlog DB view/projection
  (or an equivalently constrained read-only DB access surface) containing only the selected `project_key`.
- **Revision-aware:** dispatch records the ticket revision/body hash it was planned against. Live
  `forge backlog show` may reveal a newer revision, but that does not rewrite historical task inputs; Forge
  surfaces the revision mismatch so the agent/orchestrator can reconcile it explicitly.
- **SQLite-correct:** concurrent host writes are atomic to readers; WAL/sidecar behavior and atomic projection
  refresh are handled deliberately. A read-only mount must never produce a torn or silently stale ticket.

FG-608 owns this cutover requirement because it is the slice that makes DB authority real. Later queue/claim
slices consume the same ticket revision; they do not invent a second container backlog channel.

## Relations

- FG-380: host-local operational state for handoff/orient/session notes.
- FG-474 / FG-495: verification speed work depends on durable backlog coordination for autonomous runs.
- FG-498: GitHub Issues ingestion into the DB-backed backlog.
- Gas City / Beads lesson: the active work item should be a durable store primitive, not whichever markdown file exists in the current worktree.

## Operator Queue Contract (binding acceptance extension, 2026-07-18)

FG-496 must establish the durable primitives for an operator-curated work queue. This is not a numeric severity scale and it is not another campaign-item status language.

### Orthogonal state model

- Ticket lifecycle remains distinct from planning and execution. `active` means open; `done` means closed; `deferred` means intentionally ineligible. The legacy `blocked` ticket status migrates to an active ticket plus durable blocker evidence.
- `priority_rank` is nullable and is a stack-rank across open tickets, not a 1–5/P0–P4 score. Unranked tickets remain valid backlog items.
- Queue membership is explicit and independent of rank. A queued ticket is an operator-selected subset of the backlog; the executable queue is queued tickets sorted by `priority_rank`.
- Use one canonical rank, not a separate backlog priority and queue position that can drift.
- `in_progress` is derived from live Forge run/campaign state. `blocked` is derived from readiness, dependency, campaign, or run evidence. Neither becomes a second mutable ticket status.
- A queued ticket that becomes blocked retains its rank. Resolving the blocker returns it to the same queue position. A done ticket leaves the active queue while its queue history remains auditable.

### Queue eligibility and readiness

- Enqueue requires an active ticket and a revision-bound readiness result of `ready`, or `exploratory` for explicitly exploratory work.
- Reuse FG-382 / `forge readiness`; do not invent an unrelated readiness vocabulary. Mechanical readiness checks problem/goal/expected behavior, acceptance criteria where applicable, scope, and dependencies.
- Readiness is stored against the ticket revision/body hash. Editing the ticket invalidates the assessment until it is checked again.
- Semantic refinement may be performed by a small bounded ticket-refiner/readiness agent, but the agent is not the authority that declares its own work ready. The deterministic readiness gate reruns after refinement.

### Required DB/API behavior

- Persist nullable stack rank, explicit queue membership, readiness outcome + assessed ticket revision, and append-only enqueue/dequeue/reorder/readiness events.
- Enqueue, dequeue, and reorder are atomic and safe under concurrent operators/controllers.
- Provide one canonical ordered-queue query for CLI, campaign planning, autonomous execution, and dashboard consumers.
- Persist atomic queue claims with owner, lease/heartbeat, claimed ticket revision, launch/run identity, and release/terminal outcome so a dispatcher can recover without duplicate execution.
- Support an atomic claim-next operation that scans canonical rank order, applies caller-supplied deterministic eligibility/compatibility constraints, and cannot exceed the configured active-run capacity under concurrent dispatchers.
- Persist enough scheduling evidence to distinguish blocked, readiness-ineligible, already claimed/in progress, and temporarily incompatible-with-active-runs without changing canonical rank.
- Migration preserves current active/done/deferred state and converts legacy blocked tickets to durable blocker evidence without silently making them executable.
- Tests cover ranked and unranked backlog items, explicit queue membership, reorder, readiness invalidation after edit, a blocked queued item retaining rank, temporary compatibility bypass without rank mutation, concurrent claim/capacity races, expired-lease recovery, and done removal from the active queue.

The interactive Kanban/dashboard and capacity-limited dispatcher are a dependent operator-surface story; FG-496 owns the source-of-truth primitives they consume. A campaign may read backlog tickets, but ordinary queue dispatch does not require a campaign snapshot.

## Decomposition (2026-07-24) — FG-496 is a parent tracking story; work ships as five sequential children

An architecture + decomposition pass established that **nearly every backlog reader funnels through the
`src/backlog/structured.ts` seam.** Migrating behind that seam migrates almost all consumers at once; the real
"consumer migration" work is the handful of stragglers that bypass it (the dashboard's canonical
main/master-checkout resolution, and the `existsSync('backlog')` dir-presence guards in campaign code). The
authoritative cutover is a single flip of a per-project storage mode, safe only after those stragglers are
migrated. Every slice is **additive-only** to `~/.forge/forge.db` (`CREATE TABLE IF NOT EXISTS` +
`PRAGMA table_info`-guarded `ALTER`, never a `user_version` bump) so it cannot brick concurrent host processes
or trip the FG-568 forward gate.

Children (each independently shippable + testable, in sequence):

1. **FG-606 — Slice A:** DB ticket schema (`tickets` / `ticket_events` / `ticket_relations`, explicit `type`) +
   idempotent Markdown import as a non-authoritative shadow. Zero authority change, zero reader coupling. As the
   schema-foundation slice it ALSO fixes two load-bearing schema decisions the epic depends on: (a) a stable
   cross-worktree **project identity** — a durable `project_key` in `.forge/config.yml`, all ticket tables keyed
   by `(project_key, ticket_id)`, storage mode stored host-side in the DB under `project_key`, id allocation a
   transactional sequence per `(project_key, prefix)`; and (b) a **minimal `blocker_evidence` table** with
   legacy `blocked` mapped to active + evidence at import, so blocker state survives the Slice C cutover (which
   precedes Slice D).
2. **FG-607 — Slice B:** DB-backed CRUD behind the structured.ts seam + per-project storage mode
   (`markdown` | `db`); default stays `markdown`. Delivers the FG-495 cross-worktree shape in db mode.
3. **FG-608 — Slice C:** migrate the seam-bypassing readers (dashboard ticket source, campaign dir-guards) +
   container read-only ticket access + `forge backlog migrate` (import + atomic flip). **This slice is the
   authoritative-cutover point** — DB becomes source of truth. Post-cutover import conflict rule: create-only,
   divergent ids write a conflict event, Markdown never silently clobbers a newer DB edit (`--force` to
   override).
4. **FG-609 — Slice D:** queue primitives — canonical nullable `priority_rank`, explicit queue membership,
   revision-bound readiness (reuse FG-382), and ENRICHMENT of Slice A's minimal blocker evidence, append-only
   event history. Derived `in_progress`/`blocked` are computed, never stored.
5. **FG-610 — Slice E:** atomic queue claims / leases / recovery / capacity accounting + the canonical
   atomic claim-next query that FG-591 consumes. Primitives only — no dispatcher, no UI.

### Dependency chain

`FG-606 → FG-607 → FG-608 (cutover) → FG-609 → FG-610`. FG-591 (Kanban/CLI/API + running dispatcher) consumes
FG-610's claim-next query and FG-609's rank/queue/readiness fields; FG-591 does not start until FG-496's
primitives it depends on have landed.

### Closure rules for FG-496 (this parent story)

- FG-496 closes only when **all five children (FG-606…FG-610) are closed** AND its combined Acceptance
  Criteria + the binding Operator Queue Contract above are walked with per-line evidence (per the closing
  gate). Children carry the concrete AC; FG-496's own close is the aggregate walk, not a "children passed" rubber stamp.
- Do NOT close FG-496 on partial slices. Unmet AC keeps it open; newly discovered scope is a NEW child/follow-up, never a reason to close early.
- The boundary with FG-591 is firm: FG-496 stops at the canonical claim-next query. Any UI, operator control,
  or running dispatcher work belongs to FG-591 and must not be pulled into a FG-496 child.

### Resolved architecture decisions (operator, 2026-07-24)

- **Storage granularity:** per-project, keyed by stable `project_key`; storage mode stored host-side in the DB
  under that key (not per-worktree config), so two worktrees cannot disagree. (FG-606 / FG-607)
- **ID allocation:** transactional sequence per `(project_key, prefix)`. (FG-606 / FG-607)
- **`forge backlog migrate`:** one atomic import + validation + mode flip, with `--dry-run`; on any failure
  Markdown remains authoritative (no half-migrated project). Cutover is per-project opt-in — no global flip.
  (FG-608)
- **Dashboard:** per-project board in FG-608; cross-project aggregation belongs to FG-591. (FG-608)
- **Import conflicts:** skip and record a conflict by default; `--force` overwrites only when explicitly
  supplied and must record before/after evidence. (FG-608)
- Additive-only migration / no `user_version` bump confirmed (matches the FG-568 forward-gate contract).

### Migration path for other Forge projects

Default-safe: every other project keeps reading its own `backlog/*.md` untouched throughout the build (mode
defaults to `markdown`; the additive shared-DB tables sit unused until opted in). Per-project opt-in: run
`forge backlog migrate` in a project when ready. Cutover is effectively one-way — once a migrated project makes
DB-only edits, its Markdown is a frozen snapshot (no export; FG-496 non-goal), so clean rollback exists only
before the first DB-only edit.
