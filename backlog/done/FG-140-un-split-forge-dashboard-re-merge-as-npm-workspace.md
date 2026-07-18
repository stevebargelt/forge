---
id: FG-140
type: story
status: done
title: "Un-split forge-dashboard: re-merge as npm workspace"
---

**Closed:** 2026-05-25. Commit `d148962`.

Reverses #137 (the dashboard split). Filed and closed in the same session (2026-05-24).

> ⚠️ **SUPERSEDED IN PART by FG-571 (2026-07-16).** This closed ticket records the `forge dashboard start`
> subcommand it shipped, when there was one `forge` — the live checkout. FG-571 splits stable from dev: the
> dashboard is a separate workspace with its own dependency tree and is **not bundled into a release**, so
> stable `forge` refused `dashboard` in release mode. **SUPERSEDED AGAIN by FG-580 (2026-07-17, `bc9286f`):** the
> dashboard is now BUNDLED into the release and `forge dashboard` runs from a promoted release (offline-booting);
> `./bin/forge-dev dashboard start` from a source checkout still works too. **What this ticket actually did — un-splitting the dashboard back into an npm workspace —
> stands and is unaffected**; only the invocation moved.


**Why reverse.** Two costs surfaced after #137 shipped:
1. **Setup friction.** Multi-project use (the "install once" ergonomic established by #138) required two separate installs — one for forge, one for forge-dashboard. Contradicts the install-once shape.
2. **Schema drift risk.** Dashboard reads forge's SQLite directly. The schema contract was prose, not code. Cross-repo meant any forge schema change could silently break the dashboard at runtime instead of build time.

The original split rationale ("dashboard is separately optional, cross-project survey surface, big rewrite easier in its own repo") is still valid as a logical separation — but the repo split was the wrong axis. npm workspaces give us the logical separation without the operational cost.

**What shipped (commit d148962).**
- `dashboard/` workspace inside the forge repo. Root package.json declares `"workspaces": ["dashboard"]`. Dashboard's only own dep is `marked`; shared devDeps and better-sqlite3 hoist to root node_modules.
- `forge dashboard start [--port N] [--host H]` subcommand. Wraps spawn of tsx against the workspace's src/server.ts; resolves the workspace dir via fileURLToPath walk-up so it works regardless of cwd.
- TypeScript path alias `@forge/types` → forge's src/types/index.ts wired in dashboard/tsconfig.json. dashboard/src/queries.ts re-exports forge's Run/Task types (replacing dead duplicate exports).
- New short dashboard/CLAUDE.md (~30 lines, dashboard-specific) — NOT the standalone repo's CLAUDE.md, which was 100% generic orchestrator block and would have created inconsistency with how forge's own src/ is edited.
- Docs updates: README Dashboard section + intro + Where-things-live table, docs/quick-start.md step 11, docs/SCHEMA-CONTRACT.md top-line note about the merge.

**Honest scope caveats.**
- **Type extraction is largely cosmetic.** queries.ts had dead exports (RunRow/TaskRow/VerdictRow); nothing imported them. Re-exporting forge's Run/Task removes duplication but doesn't add true compile-time drift protection — the inline `as Array<{...}>` row casts in queries.ts still hardcode snake_case column names. Real drift fix requires a single source of truth for SQL schema (typed column-name constants or schema-as-code library); explicitly out of scope, called out in docs/SCHEMA-CONTRACT.md.
- **Dashboard tests still zero.** Out of scope for this ticket.

> ⚠️ **DO NOT EXECUTE THIS CLEANUP — WARNING ADDED 2026-07-17 (FG-571 closeout).**
> **`~/code/forge-dashboard` has been REPURPOSED and is NOT currently safe to delete.** When this ticket
> closed on 2026-05-25 the directory was a leftover from the #137 split and deleting it was safe. It is not
> that directory any more: it is now a SECOND CLONE of `git@github.com:stevebargelt/forge.git`, checked out on
> branch **`dashboard-redesign`**, carrying **4 commits that exist on NO remote branch and nowhere else on
> disk**:
>
> - `4ee594c fix(dashboard): round billion-scale usage totals`
> - `61b01aa fix(dashboard): format billion-scale usage totals`
> - `28fbfda feat(dashboard): add live host plan-limit visibility`
> - `defde2d checkpoint: recover dashboard plan-limit work after crash`
>
> **Deleting the directory destroys them permanently.** `git ls-remote --heads origin dashboard-redesign`
> returns nothing and `git branch -r --contains` returns zero remote branches for every one of the four.
>
> **`git status` reports the tree CLEAN, and that is the trap** — the work is committed, just never pushed.
> The branch has **no upstream configured**, so `git log @{u}..HEAD` errors and any "0 unpushed" check that
> does not verify the upstream resolves reads as safe. It is not.
>
> **Checkpoint before any cleanup or relocation** (e.g. `git push -u origin dashboard-redesign` from that
> directory), then re-evaluate. The second bullet below (archive the GitHub repo) is unaffected and remains
> the operator's call.
>
> *This ticket's own work — un-splitting the dashboard into an npm workspace — is untouched and stands. Only
> the safety of this TODO's first bullet has changed.*

**Cleanup TODO for the user.**
- Delete ~/code/forge-dashboard/ locally (still present; safe to delete since the workspace works end-to-end and the source remains in GitHub).
- Archive the forge-dashboard GitHub repo (UI action — don't delete; cheap insurance).

**Verification:** 230/230 forge tests pass. Root + dashboard typecheck clean. forge dashboard start boots HTTP 200 on the shell + /api/feed against real data; works from cwd outside the forge repo.