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
- **Removal reconciliation (INHERITED FROM FG-606 — Slice A deferred it here).** Slice A's import is
  deliberately append-only (a ticket/relation removed from Markdown is NOT pruned from the non-authoritative
  shadow). FG-608 owns making the shadow exactly equal the current Markdown set — because the DB becomes
  AUTHORITATIVE here, removals must propagate: a ticket/relation deleted from Markdown is deleted from the DB.
  Design this carefully for the multi-worktree case (a shared `project_key` across linked worktrees): a ticket
  is only removed when it is absent from ALL of the project's sources, never destructively deleted because one
  worktree lacks it. This is the correctness gap that made a naive single-`imported_from` prune unsafe in Slice
  A; solve it properly (e.g. per-source membership) when the DB is authoritative.
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
- `src/store/backlog-import.ts` — add the multi-source-safe removal reconciliation deferred from FG-606.
- Regression anchor: `dashboard/.../routes-backlog-canonical-source.integration.test.ts` (encodes the current
  branch-local "canonical checkout is truth" contract that this slice replaces with host-wide DB truth).

## Acceptance Criteria

- Dashboard shows the same tickets when selecting a feature checkout as the canonical repo (branch-local files
  no longer determine truth), scoped per project.
- Campaign planning, review-loop, and shipping-reviewer read DB tickets (inherited from Slice B; verified here).
- Cross-worktree consistency test passes with a project's mode = db.
- **Removal reconciliation (deferred from FG-606):** after cutover, a ticket/relation removed from Markdown is
  reflected as its absence in the DB — the shadow equals the current Markdown set INCLUDING removals — and, for
  a `project_key` shared across linked worktrees, a ticket is pruned only when absent from ALL sources (never
  destructively deleted because one worktree lacks it). Test both the single-source removal and the
  multi-worktree "remove from one, keep in another" case.
- `forge backlog migrate` is atomic: on success the mode flips to db; on any failure Markdown stays
  authoritative and the mode is unchanged. `--dry-run` reports the plan without writing.
- Re-import after cutover does not duplicate or silently lose newer DB edits — a divergent id produces a skip +
  conflict event; `--force` overwrites only when explicit and records before/after evidence.
- The canonical-source regression test is updated/replaced to assert host-wide DB truth.
- A grep/lint gate fails on any NEW direct `backlog/*.md` ticket read outside the seam.

## Blocker discovered during the FG-607 architecture pass (must be resolved before the flip)

**Agent containers cannot see db-mode tickets.** Agents get a read-only `/project` mount and no host DB, so
once a project's tickets live only in the DB, every containerized agent loses ticket visibility — including
the shipping-reviewer red, which reads a ticket's acceptance criteria from the mounted project to review a diff
against it. The seam cannot fix this from inside the container. Decide and implement the access path (inject the
ticket body into the task package, mount a read-only export, or expose a read API) as part of this slice; the
per-project flip to `db` is not safe until it is.

**Seam-bypassing `existsSync('backlog')` gates enumerated in FG-607 and deliberately left here:**
`src/campaign/executor.ts:158` (`hasBacklog()`, consumed at :194 and :213 where absence yields the
`invalid_project_dir` campaign blocker) and `src/campaign/report.ts:34` (returns null, so reporting silently
produces nothing). FG-607 converts only the two CLI sites (`src/cli/commands/backlog.ts:202` and `:275`).

## Dependencies / Relations

- Parent: FG-496. Epic: FG-593.
- Depends on: Slice A (FG-606), Slice B (FG-607).
- This slice defines the authoritative-cutover point for FG-496, and owns the removal-reconciliation FG-606 deferred.

## Non-Goals

- No queue rank/membership/readiness (Slice D), no claims (Slice E), no UI/dispatcher and no cross-project board
  (FG-591). `init` still scaffolds `notes.md` (operational); it must not gate ticket features on the dir. No
  Markdown export; forge.db and `backlog/*.md` are deliberately NOT reconciled after cutover.

## Additional removal-reconciliation case found during FG-607 review (2026-07-24)

**Stale blocker evidence survives a re-import, so a ticket reads as `blocked` after it was unblocked.**
`src/store/backlog-import.ts:286-296` upserts a `blocker_evidence` row for a source ticket whose status is
`blocked`, but has NO inverse deletion when a later import supplies `active` / `done` / `deferred` for that same
ticket. `src/backlog/structured.ts:519` reconstructs any `active` row carrying that evidence as `blocked` — so in
db mode the ticket stays blocked forever after the Markdown said otherwise, and `src/readiness/readiness.ts:83`
then holds it back from campaign dispatch.

This is the SAME append-only-import boundary this slice already owns: FG-606 deliberately made import additive,
and FG-607's own blocked round trip is symmetric on the SEAM side (write `blocked` -> evidence row; write any
other status -> delete it) but cannot fix the IMPORT side without taking on the removal semantics deferred here.
Handle it with the rest of removal reconciliation, and apply the same multi-worktree caution: evidence recorded
from one source must not be dropped merely because a sibling worktree's Markdown lacks the blocked marker.

Found by red-security during the FG-607 post-fix re-audit (medium; fail-safe direction — it withholds a ticket
from dispatch rather than wrongly shipping one).

## Identity re-identify path REQUIRED before the cutover (found during FG-607 review, 2026-07-24)

FG-607 added a read-side identity refusal: `src/backlog/storage-mode.ts:71-72` refuses whenever the registry's
`repoEvidenceKey` for a committed `project_key` differs from the checkout's computed evidence. That guard closes a
real trust boundary (a copied `.forge/config.yml` otherwise reads and WRITES another project's tickets), and it
stays.

But the evidence key is **source-dependent**: `src/util/repository-identity.ts` prefers a normalized remote and
falls back to the git common dir. A repository registered while it had NO remote gets a DIFFERENT evidence key the
moment `git remote add origin` runs (SSH vs HTTPS spellings converge; remote-absent vs remote-present does not).
After that, the refusal fires on EVERY `forge backlog` command, the printed repair is wrong for this case (it says
to reconcile config to the registered key, but the mismatch is on the evidence side), and there is **no in-tool
way to re-identify** — so the project's db tickets are stranded.

This cannot fire today because no project has a committed `project_key` yet; it becomes reachable exactly when
this slice's `forge backlog migrate` starts committing one. So it is a **precondition of the cutover**, not a
follow-up to it.

Required here: an operator-present re-identify path (e.g. `forge backlog reidentify --confirm`) that updates the
registry's evidence for a key the operator asserts, consistent with the existing boundary that identity CLAIMS
happen in import / mode-set / migrate where an operator is present — never on the read path. Also correct the
refusal message so it names the evidence-side mismatch and points at that command.

Found by red-backend during the FG-607 post-fix re-audit (medium).

---

## Folded in: FG-616 (2026-07-25)

`dashboard/src/queries.ts` keeps its own module-eval `FORGE_HOME`/`DB_PATH` snapshot — the same latent
shape as the FG-607 store-path bug.

Folded here rather than tracked separately: this ticket already owns the dashboard's seam-bypassing
readers, and the issue is latent (not reachable in the dashboard's current single-home usage). Fix it as
part of the seam migration rather than as its own ticket.
