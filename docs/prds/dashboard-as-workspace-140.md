# SPEC — dashboard as npm workspace (#140)

> ⚠️ **STATUS (2026-07-16): every `forge dashboard start` invocation below is SUPERSEDED by FG-571.**
> They assumed one `forge` — the live checkout. FG-571 splits stable from dev, and the dashboard is a separate
> workspace with its own dependency tree that is **not bundled into a release**, so stable `forge` **refuses**
> `dashboard` in release mode rather than pretending to run. Read every such line as
> `./bin/forge-dev dashboard start` from a source checkout. **Whether a stable release should ship the
> dashboard at all — bundled, separately versioned, or intentionally unavailable — is an OPEN product decision
> reserved to the operator under FG-572; nothing here decides it.** The workspace/hoisting outcome this PRD
> specifies is unaffected and stands.


**Status:** draft, awaiting confirmation
**Backlog linkage:** closes #140. Reverses #137 (the dashboard split).

## Objective

Re-merge forge-dashboard into the forge repo as an npm workspace. This eliminates the two costs that the #137 split introduced:

1. **Setup friction.** Single `git clone && npm install` should cover everything — currently requires installing two repos and running two separate `npm start` flows.
2. **Schema drift.** Dashboard currently re-declares Run/Task row types in its own `queries.ts`. After this spec, dashboard imports those types directly from forge's `src/types/`. Any forge schema change becomes a TypeScript error at dashboard build time instead of a runtime surprise.

The original split rationale — "dashboard is separately optional, cross-project survey surface, big rewrite easier in its own repo" — is preserved as a **logical** separation (own workspace package, own CLAUDE.md, own design corpus). What goes away is the **repo** separation.

After this spec lands:

- `cd ~/code/forge && npm install` installs forge + dashboard with hoisted shared devDeps.
- `forge dashboard start` boots the web view on port 8024 (wraps the underlying tsx invocation).

> **SUPERSEDED IN PART by FG-571/FG-572 (2026-07-16).** Every `forge dashboard start` invocation in this
> accepted PRD assumed one `forge` — the live checkout. FG-571 splits stable from dev, and the dashboard is a
> separate workspace with its own dependency tree that is **not bundled into a release**, so stable `forge`
> **refuses** `dashboard` in release mode rather than pretending to run. Run it from a source checkout:
> `./bin/forge-dev dashboard start`. **Whether a stable release should ship the dashboard at all — bundled,
> separately versioned, or intentionally unavailable — is an open product decision reserved to the operator
> under FG-572; this note does not decide it.** The workspace/hoisting outcome this PRD specifies is
> otherwise unaffected and stands.
- Dashboard's `queries.ts` imports row types from forge's `src/types/index.ts` — drift = build error.
- README + quick-start describe a single install flow with the web view as an optional `forge dashboard` subcommand call, not a second-repo setup.
- The standalone `~/code/forge-dashboard/` directory and GitHub repo are retired (deleted locally; archived on GitHub).

## Out of scope (deferred)

- **Adding tests to the dashboard.** Currently zero `*.test.ts` files. Adding tests is a separate ticket — this spec doesn't gate on it.
- **Moving forge CLI to `packages/cli/`.** Option B from the discussion. Idiomatic monorepo layout but disrupts every existing path (bin entry, install-seeds.sh paths, docker build context, test glob, all the docs). Not worth the churn.
- **Consolidating dashboard's read-only DB access with forge's read-write store layer.** Different concerns; dashboard intentionally bypasses forge's write paths. Leave separate.
- **Renaming the dashboard package.** `forge-dashboard` stays as the package name in `dashboard/package.json`.
- **A standalone `forge-dashboard` binary on PATH.** The `forge dashboard` subcommand replaces it.

## Commands (new + changed CLI surface)

### `forge dashboard` — new top-level command

```
forge dashboard start                 # boot the web view; default port 8024
forge dashboard start --port <n>      # custom port
```

Implemented as a thin wrapper that:
1. Resolves the workspace dir (`<forge-root>/dashboard`).
2. Spawns `tsx src/server.ts` in that dir, inheriting stdio.
3. Passes any `--port` flag via env or arg (dashboard's server reads PORT from env today).

Future verbs (`forge dashboard build`, `forge dashboard test`) can land later — out of scope for this spec.

### Everything else — unchanged

`forge new`, `forge invoke`, `forge backlog`, `forge init`, `forge gate`, `forge next`, `forge show`, `forge watch`, `forge retry`, `forge auth`, `forge status` unaffected.

## Project structure (files touched)

### Root-level structural changes

- `package.json` — add `"workspaces": ["dashboard"]`. No other changes to forge's own scripts/deps.
- `tsconfig.json` — verify the root tsconfig still excludes `dashboard/` (or set it up so dashboard has its own tsconfig that doesn't conflict). Likely just confirm.
- `.gitignore` — verify `node_modules` glob covers `dashboard/node_modules` (it does by default).

### Dashboard workspace creation

Move from `~/code/forge-dashboard/` to `~/code/forge/dashboard/`:
- `dashboard/package.json` — keep name `forge-dashboard`, only own dep `marked`. Devs come from root via hoisting. Add `"forge": "*"` to dependencies once forge is a workspace-resolvable package, OR use TypeScript path mapping in dashboard's tsconfig to alias forge types. (Decision in implementation: prefer path mapping — simpler, no need to make forge itself a published-shape package.)
- `dashboard/tsconfig.json` — extends root tsconfig if useful; adds `paths` aliasing `@forge/types` (or similar) to `../src/types/index.js`.
- `dashboard/src/` — `queries.ts`, `server.ts`, `shell.ts` (copy as-is).
- `dashboard/client/` — `main.js`, `renderers.js` (copy as-is).
- `dashboard/design/` — `dashboard.pen`, `designs/`, `inspiration/`, `system-map.png`.
- `dashboard/CLAUDE.md` — copy as-is from the standalone repo.
- `dashboard/README.md` — copy + edit: drop the standalone install instructions, point at root README for setup, keep the "what this is" / "relationship to forge" sections.

### Type extraction (drift fix)

- `src/types/index.ts` — verify `Run` and `Task` types are exported with all the columns dashboard reads (`projectDir`, `metadata`, `createdAt`, `completedAt`, etc.). They already are — dashboard's `RunRow`/`TaskRow` are duplicates with slightly different naming.
- `dashboard/src/queries.ts` — replace local `RunRow`/`TaskRow` type definitions with imports from forge's `src/types/index.ts`. Keep the SQL query functions but their return types come from forge. ~30 LoC of cleanup.

### CLI wiring

- `src/cli/commands/dashboard.ts` — NEW. Registers the `forge dashboard` command. Action handler spawns `tsx` against `dashboard/src/server.ts`. Resolves the dashboard dir via `import.meta.url` walk-up (same pattern as `init.ts` uses for `seeds/orchestrator-template.md`).
- `src/cli/index.ts` — register the new command via `registerDashboard(program)`.

### Docs

- `README.md` — rewrite the "Dashboard" section. Replace the two-block install with a single line: "`forge dashboard start` boots the web view." Update the "Where things live" table.
- `docs/quick-start.md` — update step 11 (current "Dashboard (optional)") to match: `forge dashboard start` instead of `cd ~/code/forge-dashboard && npm install && npm start`.
- `docs/how-to-use-forge-across-projects.md` — update any references to the standalone dashboard (search the doc; the dashboard is mentioned in passing as "the cross-project survey surface").
- `docs/SCHEMA-CONTRACT.md` — keep, but add a top-line note that as of #140, schema coupling is enforced at TypeScript level by dashboard importing forge's types. The doc remains useful as the narrative explanation; the types remain the authoritative contract.

### Cleanup (after merge verified)

- Delete `~/code/forge-dashboard/` directory locally (only after the merged dashboard works end-to-end).
- Archive the forge-dashboard GitHub repo via the GitHub UI (mark as archived; don't delete — cheap insurance).

## Code style

- TypeScript strict mode, `noUncheckedIndexedAccess` on. Run `npm run typecheck` (root) and `npm --workspace=dashboard typecheck` before committing.
- ES modules; `.js` suffix on every import from a `.ts` file. Holds for both packages.
- Commander pattern for the new `dashboard` command, matching `src/cli/commands/{init,invoke,backlog}.ts`.
- No comments unless the WHY is non-obvious. The `forge dashboard` command exists mainly as ergonomic glue; one-line WHY at the top is enough.
- Three similar functions > premature abstraction. Don't extract a generic "subcommand-that-wraps-npm-workspace" helper just because `forge dashboard` might one day be joined by `forge <something-else>`.

## Testing strategy

Existing baseline: 236/236 tests in forge after the cross-project-usability commit (`2320404`). Dashboard has zero tests.

### New tests

- `src/cli/commands/dashboard.test.ts` — NEW. Pure-function test of any path-resolution helper if extracted. Don't subprocess-test the actual spawn (the existing test architecture doesn't do that pattern; consistent with how I handled status.test.ts in #138).
- No new tests inside `dashboard/`. Out of scope per the spec's "out of scope" list.

### Type-extraction verification

After `dashboard/src/queries.ts` imports types from `../src/types/index.ts` (or wherever the workspace alias resolves):

- `npm --workspace=dashboard typecheck` passes.
- Manually break it as a smoke test: rename a column on the forge side, confirm dashboard typecheck fails. Revert.

### Manual verification

After implementation:

1. From a clean clone: `cd ~/code/forge && npm install`. Confirm `dashboard/node_modules` does NOT contain duplicates of `better-sqlite3`, `tsx`, `typescript` (they hoist to root).
2. `forge dashboard start` boots, listens on 8024, serves the index page.
3. Open http://127.0.0.1:8024 in a browser. Confirm activity feed renders against the current `~/.forge/forge.db`.
4. Mutate a run via `forge gate <task-id> advance`. Refresh dashboard. Confirm the state change reflects (the dashboard shells out to `forge` for mutations, but the read view should pick up the new state on next poll).
5. `forge --help` shows the new `dashboard` subcommand.
6. From a fresh terminal in a non-forge project: `forge dashboard start` works (the subcommand resolves the workspace dir via the binary's location, not cwd).

### Regression check

- Forge's existing 236 tests all pass.
- `npm run typecheck` (root) clean.
- `forge backlog list --status active` still works.
- `forge status` (with the workspace filter from the prior commit) still works.

## Boundaries

### Always do

- Preserve the `forge` CLI's existing structure at the repo root. No moves of `src/`, `bin/`, `docker/`, `scripts/`, or `seeds/`.
- Preserve the existing `~/.forge/forge.db` schema. No schema changes in this spec.
- Keep dashboard's read-only DB-open contract (no writes from the dashboard process).
- Run typecheck (root) AND `npm --workspace=dashboard typecheck` before any commit.

### Ask first about

- Any change to the forge CLI's bin path, install instructions, or PATH setup.
- Any move of forge source files (this spec only adds `dashboard/` and `src/cli/commands/dashboard.ts`; nothing in existing forge source moves).
- Changes to the schema contract doc beyond the small "now enforced via TypeScript" addendum.

### Never do

- Move forge CLI to `packages/cli/`. Explicitly deferred.
- Add a build step to dashboard (it runs via `tsx`, no build).
- Make dashboard a published npm package (it's `private: true`, stays that way).
- Delete the forge-dashboard GitHub repo. Archive only.
- Touch the verdict aggregation rule, the Docker spawn pattern, or any state-machine status values.

## Implementation order

1. **Add workspace declaration to root package.json.** Verify `npm install` from root works and `dashboard/` is recognized once it exists.
2. **Copy dashboard files into `dashboard/`** — package.json, tsconfig.json, src/, client/, design/, CLAUDE.md, README.md. Don't bring the `.git/` dir.
3. **Wire workspace dep resolution.** Either add `"forge": "*"` to `dashboard/package.json` + ensure forge's root package.json exposes the types via `exports`, OR set `paths` in `dashboard/tsconfig.json` aliasing forge types. Pick whichever works without modifying forge's package.json.
4. **Extract types.** Replace `dashboard/src/queries.ts` local `RunRow`/`TaskRow` with imports from forge's `src/types/`. Run `npm --workspace=dashboard typecheck` — should be clean.
5. **Add `forge dashboard` subcommand.** New file `src/cli/commands/dashboard.ts`. Register in `src/cli/index.ts`. Verify `forge dashboard start` boots the server.
6. **Update docs.** README dashboard section + quick-start step 11 + cross-projects doc references.
7. **Run all verification steps.** Forge tests (236), dashboard typecheck, manual browser check, regression checks.
8. **Cleanup.** Once verified, delete `~/code/forge-dashboard/` locally. Archive the GitHub repo (user does this in the UI).
9. **Commit.** Single commit referencing #140 (and re-opening #137 in spirit — note in the body).

Each step is independently verifiable. If step 3 (workspace dep resolution) is finickier than expected, pause and decide between the two approaches before proceeding.
