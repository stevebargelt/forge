---
id: FG-608
type: story
status: active
title: "FG-496 Slice C: migrate seam-bypassing readers (dashboard, campaign dir-guards) + authoritative DB cutover"
created: 2026-07-24
---

## Slice C of FG-496 — consumer migration + THE authoritative cutover

This is the ONLY slice that changes default authority. Migrate the readers that **bypass** the structured.ts
seam, then flip the per-project default storage mode to `db`. Slice B already migrated every seam consumer;
this slice migrates the stragglers and performs the single-flip cutover via `forge backlog migrate`
(import + atomic mode flip).

The cutover is safe at exactly this point and no earlier because (a) every seam reader inherited DB behavior
in Slice B, and (b) this slice migrates the only readers that bypass the seam — the dashboard ticket-source
resolution and the campaign backlog-dir guards. Flipping before this would leave the dashboard (or a dir
guard) serving stale branch-local Markdown while the DB is truth.

## Scope

- **Dashboard ticket source:** rewrite `/api/backlog` ticket branch to query the DB. Delete the canonical
  main/master-checkout resolution — ticket truth is now same-host, not branch-local. Keep `notes.md` reads
  per-checkout (FG-380 operational state, orthogonal to ticket truth).
- **Campaign dir-guards:** convert `existsSync('backlog')` dir-presence guards to DB-existence checks.
- `forge backlog migrate` = idempotent import + atomic default-mode flip to `db`.
- **Post-cutover import conflict rule:** import becomes CREATE-ONLY for ids the DB has never seen. For a known
  id whose DB row was edited since its import basis (import-basis body-hash mismatch), import SKIPS and writes
  a conflict event to `ticket_events` — **Markdown loses, never silently clobbers a newer DB edit**. `--force`
  is the only override. This is the explicit conflict decision FG-496 AC demands.

## Files (grounded)

- `dashboard/src/server.ts` (~lines 112–163) — rewrite ticket branch to DB query; keep `notesByCheckout` FS reads.
- `dashboard/src/queries.ts` — add the ticket query.
- `src/cli/commands/campaign.ts:504`, `src/campaign/report.ts:34`, `src/campaign/executor.ts:159` — dir-guards → DB.
- Regression anchor: `dashboard/.../routes-backlog-canonical-source.integration.test.ts` (encodes the current
  branch-local "canonical checkout is truth" contract that this slice replaces with host-wide DB truth).

## Acceptance Criteria

- Dashboard shows the same tickets when selecting a feature checkout as the canonical repo (branch-local files
  no longer determine truth).
- Campaign planning, review-loop, and shipping-reviewer read DB tickets (inherited from Slice B; verified here).
- Cross-worktree consistency test passes with **default mode = db**.
- `forge backlog migrate` is idempotent; re-import does not duplicate or silently lose newer DB edits — a
  divergent id produces a conflict event, not a clobber.
- The canonical-source regression test is updated/replaced to assert host-wide DB truth.
- A grep/lint gate fails on any NEW direct `backlog/*.md` ticket read outside the seam.

## Dependencies / Relations

- Parent: FG-496. Epic: FG-593.
- Depends on: Slice A (FG-606), Slice B (FG-607).
- This slice defines the authoritative-cutover point for FG-496.

## Non-Goals

- No queue primitives (Slice D), no claims (Slice E), no UI/dispatcher (FG-591). `init` still scaffolds
  `notes.md` (operational); it must not gate ticket features on the dir. No Markdown export; forge.db and
  `backlog/*.md` are deliberately NOT reconciled after cutover (Markdown becomes a frozen legacy snapshot).

## Open decisions (surface at planning)

- `forge backlog migrate` as a single import+flip command (proposed, with `--dry-run`) vs two explicit steps
  (import, then a separate `use-db` confirmation).
- Dashboard after cutover: per-project ticket board (proposed) vs host-wide cross-project board (arguably FG-591).
