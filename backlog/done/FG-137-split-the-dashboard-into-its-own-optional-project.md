---
id: FG-137
type: story
status: done
title: Split the dashboard into its own optional project
---

**Closed:** 2026-05-14. Commit `1d586ff`.

**Why:** Steven's call 2026-05-14, post-v2-cutover. The dashboard inside the forge monorepo couples release cadence (UI iteration is faster than runner iteration), forces every install to carry ~4K LoC of UI + htmx + server.ts whether they use it or not, and — most importantly — scopes the dashboard to "this project's runs" when it actually wants to be a *user-level tool* that views every forge run across every project on the host. `~/.forge/forge.db` is already host-global; the dashboard just needs to read it directly.

**Target shape:**
```
forge/              (this repo) — CLI + v2 runner + seeds
forge-dashboard/    (new repo)   — web UI; reads ~/.forge/forge.db; shells `forge` for actions
```
Installs separately. Runs as `forge-dashboard` or `npx forge-dashboard` on its own port. Discovers runs from `~/.forge/`; groups by `run.projectDir` for multi-project view.

**Trade you're making:** the SQLite schema + filesystem layout become a contract between the two repos. Today you can change a column + update queries.ts in one PR; after the split, schema changes need to think about dashboard compatibility. Worth paying, but name it.

**Three lock-points before doing the split:**
1. **Schema contract.** Write `docs/SCHEMA-CONTRACT.md` capturing what the dashboard reads from `forge.db` + filesystem (Run/Task/Verdict/Gate/Event tables; `~/.forge/runs/<runId>/<taskId>/{result.json,container.stdout.log,...}`). Once split, that document is the API. Anything outside it is implementation detail forge can change freely.
2. **Pill row first or last?** The current pill row is broken (stubbed from v2 deletion — see #136). Option (a): rebuild in this repo against v2 schema, then split. Option (b): split now with the pill row still stubbed; rebuild it in the new repo as its first feature. **Lean (b)** — splitting is the bigger architectural decision; don't gate it on one feature.
3. **`forge invoke` rendering.** Single-task invokes show up today as run rows with workflow="invoke". The dashboard should keep showing them, but they have no pipeline shape. Decide before split: render as single-pill "task" view, or special-case the layout.

**Not blocking anything else.** v2 ships without it; this is a future arc. Probably comes after #136 (or absorbs it).

**Caught:** 2026-05-14 — during post-v2 reflection on dashboard scope.