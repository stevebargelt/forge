---
id: FG-608
type: story
status: active
title: "FG-496 Slice C: migrate seam-bypassing readers (dashboard, campaign dir-guards) + authoritative DB cutover"
created: 2026-07-24
---

## Slice C of FG-496 — consumer migration + THE authoritative cutover (per project)

This is the ONLY slice that changes default authority, and it does so **per project**, opt-in — never a global
flip that would strand unmigrated projects with an empty DB. Migrate the readers that **bypass** the
structured.ts seam, then flip a project's stored mode (host-side, keyed by `project_key`) to `db` via
`forge backlog migrate`. Slice B already migrated every seam consumer; this slice migrates the stragglers and
performs the single-flip cutover.

The cutover is safe at exactly this point and no earlier because (a) every seam reader inherited DB behavior in
Slice B, and (b) this slice migrates the only readers that bypass the seam — the dashboard ticket-source
resolution and the campaign backlog-dir guards. Flipping before this would leave the dashboard (or a dir guard)
serving stale branch-local Markdown while the DB is truth.

## Migration path for other projects (portfolio-wide)

- **Default is "nothing changes":** storage mode defaults to `markdown`; other projects keep reading their own
  `backlog/*.md` untouched throughout the build, including after the forge repo itself cuts over. The additive
  shared-DB tables sit unused until a project opts in.
- **Per-project opt-in:** each project cuts over by running `forge backlog migrate` in it; the forge repo is
  simply the first project migrated (dogfood), the rest follow on the operator's schedule.
- **`forge backlog migrate` = ONE atomic operation:** import → validate (shadow equals Markdown) → flip the
  host-side mode to `db`. Provide `--dry-run`. **On any failure the mode is NOT flipped — Markdown remains
  authoritative** (fail-safe; no half-migrated project).

## Scope

- **Dashboard ticket source:** rewrite `/api/backlog` ticket branch to query the DB (scoped by `project_key`).
  Delete the canonical main/master-checkout resolution — ticket truth is now same-host, not branch-local. Keep
  `notes.md` reads per-checkout (FG-380 operational state, orthogonal to ticket truth). Dashboard stays a
  **per-project board**; cross-project aggregation is FG-591, not here.
- **Campaign dir-guards:** convert `existsSync('backlog')` dir-presence guards to DB-existence checks.
- **`forge backlog migrate`** as specified above (atomic import+validate+flip, `--dry-run`, fail-safe).
- **Import conflict rule:** **skip and record a conflict by default** — a known id whose DB row was edited since
  its import basis (import-basis body-hash mismatch) is left as-is and a conflict event is written to
  `ticket_events`; Markdown never silently clobbers a newer DB edit. `--force` may overwrite **only when
  explicitly supplied**, and a forced overwrite must record **before/after evidence** in the event.

## One-way cutover property (state, don't surprise)

Because Markdown export is out of scope, once a migrated project makes DB-only edits its `backlog/*.md` is a
**frozen snapshot**. Clean rollback to `markdown` mode exists only *before* the first DB-only edit; reverting
after DB edits would lose them. Surface this in the cutover UX.

## Files (grounded)

- `dashboard/src/server.ts` (~lines 112–163) — rewrite ticket branch to DB query; keep `notesByCheckout` FS reads.
- `dashboard/src/queries.ts` — add the ticket query (scoped by `project_key`).
- `src/cli/commands/campaign.ts:504`, `src/campaign/report.ts:34`, `src/campaign/executor.ts:159` — dir-guards → DB.
- Regression anchor: `dashboard/.../routes-backlog-canonical-source.integration.test.ts` (encodes the current
  branch-local "canonical checkout is truth" contract that this slice replaces with host-wide DB truth).

## Acceptance Criteria

- Dashboard shows the same tickets when selecting a feature checkout as the canonical repo (branch-local files
  no longer determine truth), scoped per project.
- Campaign planning, review-loop, and shipping-reviewer read DB tickets (inherited from Slice B; verified here).
- Cross-worktree consistency test passes with a project's mode = db.
- `forge backlog migrate` is atomic: on success the mode flips to db; on any failure Markdown stays
  authoritative and the mode is unchanged. `--dry-run` reports the plan without writing.
- Re-import after cutover does not duplicate or silently lose newer DB edits — a divergent id produces a skip +
  conflict event; `--force` overwrites only when explicit and records before/after evidence.
- The canonical-source regression test is updated/replaced to assert host-wide DB truth.
- A grep/lint gate fails on any NEW direct `backlog/*.md` ticket read outside the seam.

## Dependencies / Relations

- Parent: FG-496. Epic: FG-593.
- Depends on: Slice A (FG-606), Slice B (FG-607).
- This slice defines the authoritative-cutover point for FG-496.

## Non-Goals

- No queue rank/membership/readiness (Slice D), no claims (Slice E), no UI/dispatcher and no cross-project board
  (FG-591). `init` still scaffolds `notes.md` (operational); it must not gate ticket features on the dir. No
  Markdown export; forge.db and `backlog/*.md` are deliberately NOT reconciled after cutover.
