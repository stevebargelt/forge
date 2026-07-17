# SPEC — cross-project usability

> ⚠️ **STATUS (2026-07-16): this accepted PRD's `npm link` install path is SUPERSEDED by FG-571.**
> Every `npm link` reference below records what was true when #138 was written. It no longer installs the
> supported machine-wide `forge`: FG-571 splits stable (a promoted, immutable release run by its own pinned
> interpreter, selected by an atomic `~/.forge/current` pointer, reached via an explicitly installed shim)
> from live-source (`bin/forge-dev`, new in FG-571). `npm link` now puts a live-checkout `forge` on `$PATH`,
> defeating the stable/dev split, the `current` pointer, and the pinned-interpreter and env-sanitization
> guarantees. **The cross-project workspace-scoping outcome this PRD specifies is unaffected and stands.**
> Current source of truth: `README.md`, `src/cli/commands/release.ts`.


**Status:** historical. This spec captured a partial-fix plan; the actual #138 ship in commit `14d4637` (a parallel implementation from another machine) covered the full three-part fix including piece b. Some details below diverge from what landed — particularly the flag name (`--workspace` shipped, not `--project`) and the store helper name (`listRunsForWorkspace`, not `listRunsForProject`). Read this as design context for the docs in this same commit; read commit `14d4637` for the actual code as shipped.

**Backlog linkage:** #138 closed by `14d4637`. The #139 follow-up this spec proposed for the deferred piece b is moot — that work also shipped in `14d4637`. Close #139 as duplicate.

---

**Original draft below (preserved unchanged for historical context):**

**Status:** draft, awaiting confirmation
**Backlog linkage:** partial close of #138 (pieces a + c); piece b (`metadata.workspace` stamping for workspace-≠-projectDir cases) deferred to a follow-up ticket.

## Objective

forge is host-global by design — one install, one `~/.forge/forge.db`, runs against any project on the host. The engine reflects this: `--project` flags on `new`/`invoke`/`backlog`, `runs.project_dir` persisted, `forge init` for per-project setup, `<project>/.forge/workflows/` for per-project overrides, `<project>/CLAUDE.md` for the orchestrator block.

But the install path, default UX, and docs all assume "cd into the forge repo and run `./bin/forge`." Three symptoms:

1. `./bin/forge` is the only documented invocation — there's no global install path, so every example forces `cd ~/code/forge` first.
2. `forge status` has zero workspace filtering, so an orchestrator session in `~/code/audit-workspace` sees runs from `~/code/forge` and tries to pick them up (#138).
3. The README and `quick-start.md` lead with `cd ~/code/forge` and use a forge-internal example (`investigation: litellm-evaluation`), making forge look like a self-hosted tool rather than a tool you point at any project.

After this spec lands:

- `forge` is on `$PATH` (via `npm link`); `cd ~/code/anywhere && forge <cmd>` works.

> **SUPERSEDED IN PART by FG-571 (2026-07-16).** This accepted PRD records the state at the time #138 was
> written, when `npm link` WAS the supported way to put `forge` on `$PATH`. It no longer is: FG-571 splits the
> machine-wide `forge` (a promoted, immutable release run by its own pinned interpreter, selected by an atomic
> `~/.forge/current` pointer and reached through an explicitly installed shim) from the live-source entry
> (`bin/forge-dev`, new in FG-571). `npm link` now symlinks a live-checkout `forge` onto `$PATH`, which
> defeats the stable/dev split, the `current` pointer, and the pinned-interpreter and env-sanitization
> guarantees. **Everything else in this PRD stands** — the cross-project workspace-scoping outcome it
> specifies is unaffected. Current source of truth: `README.md` and `src/cli/commands/release.ts`.
- `forge status` defaults to runs where `project_dir == cwd`; `--all` shows the cross-project view; `--project <dir>` filters explicitly.
- The orchestrator template explicitly documents that `forge status` is workspace-scoped and tells the orchestrator not to use `--all` when picking up in-flight runs.
- README and `quick-start.md` lead with "from your project," with forge-on-forge as a named appendix.
- A new `docs/how-to-use-forge-across-projects.md` is the single discoverable surface for the multi-project story (absorbs the existing `docs/how-to-pi-skills-in-non-forge-project.md`).

## Out of scope (deferred)

- **`metadata.workspace` stamping** at `invoke`/`new` time (#138 piece b). Needed only when workspace ≠ projectDir (e.g. an orchestrator session in `~/code/audit-workspace` driving runs against `~/code/forge`). Punt to a follow-up ticket — `projectDir == cwd` filtering covers the common case.
- Per-project customization of agents or constraints beyond what `<project>/.forge/workflows/` already supports.
- Any SQLite schema changes. No new columns. `runs.project_dir` already exists; we use it.
- Touching `docs/how-to-new-agent.md`, `docs/how-to-new-feature.md`, `docs/how-to-new-workflow.md`, `docs/how-to-new-analysis.md`. They're stable and don't lean on forge-on-forge.

## Commands (CLI surface changes)

### `forge status` — workspace-scoped by default (BEHAVIOR CHANGE)

```
forge status                        # NEW DEFAULT: runs where project_dir == cwd
forge status --all                  # cross-project view (current behavior)
forge status --project <dir>        # filter by explicit project
forge status <run-id>               # unchanged: looks up by id regardless of project
forge status --json [--all|--project] # JSON, same filtering rules
```

When the default-filtered list is empty AND there exist runs the user can't see, print a one-line hint:

```
No runs in /Users/stevebargelt/code/my-app. (12 runs in other projects — use `forge status --all` to see them.)
```

When `forge status` resolves to a specific run-id (with arg), no filtering applies — the explicit lookup wins.

### Everything else — unchanged

`forge new`, `forge invoke`, `forge backlog`, `forge init`, `forge gate`, `forge next`, `forge show`, `forge watch`, `forge retry`, `forge auth` all keep their existing `--project` semantics (cwd default where applicable, otherwise unaffected).

## Project structure (files touched)

### Code (small)

- `src/store/runs.ts` — add `listRunsForProject(projectDir: string): Run[]`. Case-sensitive exact match on the absolute `project_dir`. Runs with `project_dir IS NULL` do NOT match any project filter. Add `countRunsForeignTo(projectDir: string): number` for the "12 other runs" hint.
- `src/cli/commands/status.ts` — add `--all` and `--project <dir>` flags. Default behavior calls `listRunsForProject(cwd)`. Implement the empty-list hint. Pre-existing `--read-only` and `--json` flags unchanged.

### Seed (tiny)

- `seeds/orchestrator-template.md` lines 186-188 ("In-flight runs" section) — rewrite to state that `forge status` is workspace-scoped by default and to NOT use `--all` when scanning for in-flight work at session start. One short paragraph.
- After updating, reinstall via `./scripts/install-seeds.sh` and refresh the orchestrator block in the forge repo itself (`forge init --project ~/code/forge`) and in `~/code/audit-workspace`, `~/code/forge-dashboard` (whichever the user has).

### Docs (the bulk of the visible change)

- `README.md` — rewrite Quick Start: install + `npm link` once, then `cd ~/code/my-app && forge init`, then `forge new`. Demote the litellm example (or replace with a generic). Add a one-line "Where forge lives vs. where it runs" note pointing at `~/.forge/forge.db`.
- `docs/quick-start.md` — full rewrite. Lead with "from your project." Use a generic `~/code/my-app` shape. Drop the `./bin/forge` prefix throughout (assume `forge` on PATH). Mention `forge init` explicitly. Keep the litellm investigation as a separate short example or move it into the cross-projects doc.
- `docs/concepts.md` — add two glossary entries: **Project** (the dir mounted at `/project` in the container, recorded as `runs.project_dir`) and **Workspace** (the cwd the human runs `forge` from; usually equals project, sometimes diverges as with `audit-workspace`). Light edit to the **Run** entry to mention `projectDir`.
- `docs/how-to-use-forge-across-projects.md` — NEW. Sections:
  - Install once, use everywhere (`npm link`)
  - Per-project setup (`forge init`)
  - Running forge on the forge repo itself (the meta-development appendix)
  - Per-project workflow overrides (`<project>/.forge/workflows/<name>.yml`)
  - One forge.db, many projects (how `forge status` filtering works, when to use `--all`)
- `docs/how-to-pi-skills-in-non-forge-project.md` — delete. Content folded into the new cross-projects doc.

### Install path

- No code change in `package.json` (the `bin` entry is already correct).
- README install step says: `cd ~/code/forge && npm install && npm link`. The `npm link` is the new instruction.
- Add a single line to `scripts/install-seeds.sh` output (or document next to it) confirming forge is now on PATH if `which forge` resolves.

## Code style

Standard for this repo:

- TypeScript strict mode, `noUncheckedIndexedAccess` on. Run `npm run typecheck` before committing.
- ES modules; `.js` suffix on every import from a `.ts` file.
- Commander pattern matching `src/cli/commands/{new,invoke,backlog}.ts`.
- No comments unless the WHY is non-obvious. The `--all` flag's existence is self-evident; the empty-list hint logic deserves a one-line WHY comment ("hint surfaces the cross-project pool so the user knows what they're not seeing").
- Three similar functions > premature base class. `listRunsForProject` and `countRunsForeignTo` are two separate functions, not a base helper with options.

## Testing strategy

Existing baseline: 279/279 tests passing on `main` at `e5fd408`.

### New tests

- `src/store/runs.test.ts` — add:
  - `listRunsForProject: returns only runs with matching project_dir`
  - `listRunsForProject: omits runs with NULL project_dir`
  - `listRunsForProject: case-sensitive path match` (one positive, one negative)
  - `countRunsForeignTo: returns count of runs whose project_dir is set and != arg`
- `src/cli/commands/status.test.ts` — NEW file. Integration test using the existing `FORGE_HOME` tmpdir pattern. Seed three runs across two project dirs. Assert:
  - Default invocation (default cwd) returns only matching project's runs
  - `--all` returns everything
  - `--project <dir>` filters explicitly
  - Empty filtered result with foreign runs present prints the hint line
  - `<run-id>` argument is unaffected by filtering

### Manual verification (the spec is not done without these)

After implementation, from three different working directories:

1. `cd ~/code/forge && forge status` → only forge's own runs
2. `cd ~/code/forge-dashboard && forge status` → only dashboard runs (or empty + hint)
3. `cd ~ && forge status` → empty + hint (no runs have project_dir == `~`)
4. `cd ~/anywhere && forge status --all` → every run in the DB
5. `cd ~/anywhere && forge status <known-run-id>` → looks up by id regardless of cwd
6. From a fresh terminal in a non-forge project: `forge init` should create `<project>/CLAUDE.md` orchestrator block and `<project>/.forge/`. Then `forge new feature "test" --brief "noop"` should create a run with `project_dir == cwd`.

### Docs verification

After the rewrite, the docs verify by reading top-to-bottom — there should be zero `cd ~/code/forge` prefix in `README.md` quick start or `docs/quick-start.md` (except in the explicit forge-on-forge appendix). Search: `rg -n "cd ~/code/forge" README.md docs/` should return only appendix-marked lines.

## Boundaries

### Always do
- Preserve the existing `--project` semantics on `new`, `invoke`, `backlog`, `init` (cwd default; explicit override).
- Keep `forge status --all` as the escape hatch that reproduces today's behavior — no surprise to existing muscle memory.
- Run `npm run typecheck` and `npm test` before any commit.
- Reinstall seeds and refresh orchestrator blocks in active workspaces after the template change.

### Ask first about
- Any change to existing CLI flag names or default behaviors beyond what's listed above.
- Any schema change to `runs` or new column (this spec explicitly avoids them; doing so requires an ADR per `CLAUDE.md`).
- Renaming or deleting docs not listed in "Project structure."
- Changing the orchestrator template beyond the "In-flight runs" paragraph.

### Never do
- Add `metadata.workspace` stamping to `forge new` / `forge invoke` in this spec — that's the explicitly deferred #138 piece b. File a new ticket when this lands, don't sneak it in.
- Touch the verdict aggregation rule in `gate.ts`.
- Touch the Docker spawn pattern in `spawn.ts` (DEC-004, DEC-005, DEC-006, DEC-009).
- Relax the red read-only project mount.
- Estimate work in days/weeks — talk scope, risk, dependencies (per `CLAUDE.md`).
- Renumber backlog tickets.
- Use `--no-verify` to skip hooks, or `--no-gpg-sign` to bypass signing.

## Implementation order (dependency chain)

1. **Store + CLI code.** `listRunsForProject` + `countRunsForeignTo` in `src/store/runs.ts`; wire `--all`, `--project`, default filter, empty-list hint into `src/cli/commands/status.ts`. Tests pass.
2. **Orchestrator template edit.** `seeds/orchestrator-template.md` "In-flight runs" rewrite. Reinstall seeds. Refresh active orchestrator blocks.
3. **Docs.** README → quick-start → concepts → new cross-projects doc → delete the pi-skills doc. Manual verification commands run successfully.
4. **Backlog hygiene.** Close #138 partially (cite this commit; note piece b is deferred). File a new ticket for piece b (`metadata.workspace` stamping for workspace-≠-projectDir cases).

Each step is independently mergeable. Pause for review between steps if anything surprises.
