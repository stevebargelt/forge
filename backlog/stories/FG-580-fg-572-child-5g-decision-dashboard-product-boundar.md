---
id: FG-580
type: story
status: active
title: "FG-572 Child 5g: DECISION — dashboard product boundary across a promotion (bundle / separately version / intentionally unavailable)"
created: 2026-07-17
---

**Parent:** FG-572 · **Epic:** FG-561 · **OPERATOR-OWNED — this is a product decision, not an engineering task.**
**Source:** FG-572 read-only architecture pass, run `run-fg-572-installed-surface-compatibility-read-only-architecture-pass-75b811`, at `12b13c2`.

FG-572's third acceptance line requires EITHER a stable `forge dashboard` from a promoted release OR its
unavailability named as an accepted product boundary. **FG-561's closeout gate explicitly holds the campaign
open while stable `forge dashboard` is unavailable from a promoted release.** So this is on the campaign's
critical path and needs **no engineering to decide** — only a decision. It should be sequenced FIRST among
Child 5's work: options A and C imply completely different amounts of work.

## The cost model behind the current deferral is FACTUALLY WRONG (independently verified at 12b13c2)

`src/v2/release.ts:8-9` justifies excluding the dashboard as "a SEPARATE application workspace with its OWN
dependency tree." Verified on host:

- root `package.json` declares `workspaces: ["dashboard"]`
- `dashboard/node_modules` measures **0B** — npm **hoists** its runtime deps to the ROOT
- `marked` (the dashboard's only non-shared runtime dep) is present at `node_modules/marked` (936K)
- `better-sqlite3` is already a **root** dependency
- the release closure copies the **entire root node_modules wholesale** (`release.ts:20`)

**The release ALREADY SHIPS the dashboard's dependency tree. There is no separate tree to bundle.**

Actual unbundled delta: `dashboard/src` + `dashboard/client` (static js/png/svg). `dashboard/package.json` has
**no build step** (`start: tsx src/server.ts` — no vite/esbuild). So: source + static files, likely a few MB,
no build, no new deps, no new interpreter. `playwright-core` is a devDependency (browser-tests) and is not in
the runtime surface either way.

## Options

**A — bundle `dashboard/` as a fourth REQUIRED_ASSET_DIR.**
Release grows by `dashboard/src` + `client` only (deps already shipped). `dashboard/` becomes commit-bound like
`seeds/`, so a **dirty dashboard file refuses the build** (`release.ts:24-26`) — a real, ongoing tax on
dashboard iteration, and the strongest argument against. Requires retiring the `dashboard.ts:15` refusal and
revisiting `selfContainedFor:"control-plane"` (`release.ts:184`), since the honesty scope widens.
**UNBLOCKS FG-561. Cheapest option by a wide margin once the dependency premise is corrected.**

**B — separately versioned dashboard.**
Introduces a SECOND version identity into a campaign that spent FG-571 establishing exactly one
(content-addressing). Needs its own install location, compat policy, and drift detection — re-opens every
question FG-572 just answered, for one surface. Only justified if the dashboard must upgrade independently of
the control plane, which nothing in current evidence suggests. Highest complexity.

**C — intentionally unavailable from a release (status quo).**
Zero engineering: the refusal at `dashboard.ts:15-19` is already correct, named, nonzero, and machine-readable
via the manifest (`release.ts:184`). Honest. BUT the operator runs the dashboard from a source checkout
forever, and **FG-561 CANNOT CLOSE** — choosing C means consciously **amending the PRD closeout gate**, not
silently missing it at closeout.

## Decision needed

Pick A, B, or C. If C, the PRD's closeout gate must be amended in the same change.