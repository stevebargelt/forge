# Using forge across projects

Forge is host-global: one install, one `~/.forge/forge.db`, used against any project on the machine. This doc covers the multi-project story — install path, per-project setup, where state lives, how runs and `forge status` scope across projects, and the meta-case of running forge on the forge repo itself.

## Install once

```bash
cd ~/code/forge
npm install
./scripts/install-seeds.sh
./docker/build.sh                # one-time agent image build

./bin/forge-dev release build --out ~/forge-releases/r1        # --out must not exist, outside the checkout
./bin/forge-dev release promote ~/forge-releases/r1            # selects it machine-wide, atomically
./bin/forge-dev release install-shim --prefix /usr/local/bin   # once; any directory on your $PATH
forge auth login                 # personal Mac only
forge upgrade --skip-project     # REQUIRED — publishes the seed generation dispatch reads (see below)
forge setup                      # create the active model + routing policy from seeds; readiness check
```

`which forge` now resolves and `forge --help` runs from any directory.

**`forge upgrade --skip-project` is required on a fresh host, not optional.** `install-seeds.sh` writes only the flat `~/.forge/` copies, and since FG-583 those are **not** a dispatch source — every dispatch reads exclusively the atomic *seed generation* `forge upgrade` publishes. Until that first generation is published the host fails closed: `forge next`, gate advances, and campaign items refuse with a named no-generation state (`forge doctor` reports `Seed install: NOT INSTALLED`), repairable only by `forge upgrade`. (Run from the promoted `forge` it also refuses the `git pull` / `npm install` advancement half and closes `INCOMPLETE`; the asset half that publishes the generation still runs — add `--skip-git --skip-npm` for a clean exit.) That machine-wide `forge` is a **promoted release** — an immutable closure run by its own pinned interpreter — not your checkout: editing `~/code/forge/src/` does not change it. Build and promote again to move it; `forge release rollback` returns to the previously selected release, and `forge release current` says which one is live.

For live source, `~/code/forge/src/` is still no-rebuild-needed through `tsx` — reach it with `./bin/forge-dev <cmd>` or `npm run forge -- <cmd>`. Stable `forge` and `forge-dev` are different artifacts with different provenance, so a bug that reproduces under only one is possible; `forge release provenance` reports what a running process actually is.

Do not use `npm link` here. It symlinks a live-checkout `forge` onto `$PATH`, which defeats the stable/dev split, the `current` pointer, and the pinned-interpreter and env-sanitization guarantees, and can shadow or overwrite the shim.

`install-seeds.sh` also installs the Forge host/orchestrator skills (`forge-campaign`, `forge-review-loop`, `forge-backlog`, `forge-research-synthesis`, and `/status`) into the user-global Claude skills dir (`~/.claude/skills` by default; override with `CLAUDE_SKILLS_DEST` or `CLAUDE_CONFIG_DIR`). Because that's a Claude Code user setting rather than a forge project setting, the skills become available in **every** project on the machine after a single install — no per-project step needed. These are host/orchestrator skills; container agents don't see them (they use the separate container-only skill mount in `src/v2/spawn.ts`).

To remove the machine-wide `forge`: delete the shim you installed (e.g. `rm /usr/local/bin/forge`). The releases under `~/.forge/releases/` and the `current` pointer stay until you remove them yourself — forge never deletes a release, because live processes may still be anchored to one.

## Per-project setup

Each project that will be driven by forge needs a one-time setup:

```bash
cd ~/code/my-app
forge init
```

`forge init` does two things:

1. Installs the forge orchestrator block into `<project>/CLAUDE.md` (creates the file if missing). The block tells Claude Code sessions in this project how to route work through forge agents rather than editing source directly. It's fence-marked between `<!-- forge:orchestrator-start -->` and `<!-- forge:orchestrator-end -->`, so re-running `forge init` after a forge upgrade safely replaces the block in place.
2. Creates `<project>/.forge/` — currently used for per-project workflow YAML overrides (see below).

`forge init --dry-run` shows what it would change without writing anything.

## Two ways to drive forge in a project

After `forge init`, each project supports two interaction modes. They share the same DB, runs, gates, and result.json files — the difference is who selects the agent and assembles the brief.

### 1. Orchestrator-led (the conversational mode)

Start `claude` from inside the project directory. The orchestrator block that `forge init` installed in `CLAUDE.md` claims the session as **this project's forge orchestrator**. You describe what you want in natural language; the orchestrator:

1. Classifies the prompt (implementation / research / review / architecture / documentation / ticketing / etc.) against `~/.forge/forge-raci.md`.
2. Picks the right path: in-session (does it itself), `forge invoke <agent>` (single-agent dispatch), or `forge new <workflow>` (full pipeline run).
3. Constructs the brief, calls forge, watches each gate, presents results with a recommendation, and decides next steps with you.

You never type a `forge` command. The orchestrator does, on your behalf. Examples of what this looks like:

- *"Add OAuth login using the existing user table"* → orchestrator classifies as implementation, files (or reuses) a backlog ticket, runs `forge new feature "add-oauth-login" --brief "..." --ticket FG-42`, watches the architect → plan → build → verify → docs pipeline, presents each gate, lands the commit.
- *"Audit `src/auth/session.ts` for security issues"* → orchestrator classifies as review, runs `forge invoke red-security --task "..." --read-only`, presents findings.
- *"What runs are in flight for this project?"* → in-session: orchestrator runs `forge status --json` and summarizes.

This is the recommended path for ad-hoc and exploratory work.

### 2. Direct CLI (the scripted mode)

Run `forge new` / `forge invoke` / `forge backlog` yourself, from any terminal. The orchestrator block is not involved (you're not in a `claude` session driven by it). Useful when:

- You're scripting a repeatable workflow (CI hook, cron job, batch invocation).
- You already know exactly which workflow + agent + flags you want.
- You're driving runs from outside an interactive session (e.g. another tool calls `forge invoke`).
- You want to bypass the orchestrator's classification step for speed.

Both modes write to the same `~/.forge/forge.db` and the same `~/.forge/runs/<run-id>/` artifacts. You can drive most work conversationally and drop to direct CLI for one-off scripted invocations without any handoff.

## Where state lives

| Path | What | Scope |
|---|---|---|
| `~/.forge/forge.db` | Run/task/verdict blackboard | Host-global; one DB, all projects |
| `~/.forge/runs/<run-id>/` | Task packages, result.json, stderr | Host-global, keyed by run id |
| `~/.forge/agents/<role>/` | Agent role seeds (CLAUDE.md per agent) | Host-global |
| `~/.forge/constraints/*.md` | Suggest- and force-level constraints | Host-global |
| `~/.forge/workflows/*.yml` | Default workflow definitions | Host-global |
| `~/.forge/forge-raci.md` | RACI table the orchestrator uses to route work | Host-global |
| `~/.claude/skills/forge-*/`, `~/.claude/skills/status/` | Host/orchestrator workflow and status skills | Host-global; not seen by container agents |
| `<project>/CLAUDE.md` | Orchestrator block (installed by `forge init`) | Per-project |
| `<project>/.forge/workflows/*.yml` | Per-project workflow override | Per-project |

Per-project state is intentionally minimal: just the orchestrator block and an optional workflow override. Everything else is one install for the whole machine.

## Per-project workflow overrides

If `<project>/.forge/workflows/<name>.yml` exists, `forge new <name>` uses it instead of the host-global default. (A project override is always read directly and takes precedence; the host default itself is loaded from the atomically published seed generation, not the flat `~/.forge/workflows/` copy — see FG-583 in [how-to-new-workflow.md](how-to-new-workflow.md).) Useful when a project needs a non-default phase sequence, an extra red, or a different model alias for a step.

Most projects don't need this; the default workflows in `seeds/workflows/` cover the common cases. When you do need it, copy the seed into the project's `.forge/workflows/` and edit there:

```bash
cd ~/code/my-app
cp ~/.forge/workflows/feature.yml .forge/workflows/feature.yml
# edit .forge/workflows/feature.yml to taste
forge new feature "X" --brief "..." --ticket FG-42
```

The loader logs which YAML it picked, so you can confirm the override is taking effect.

## One forge.db, many projects

A single SQLite DB at `~/.forge/forge.db` holds runs and tasks from every project on the host. Each run records its `projectDir` at creation time (default: cwd; override: `--project <dir>`).

**A read never creates the store.** On a host that has never run forge there is no `forge.db` (and no `~/.forge/` created just by looking), so read-only survey commands — `forge status`, `forge runs query`, `forge metrics`, `forge usage`, `forge ops check`, `forge sweep` — answer with their empty result and exit 0 rather than minting a database as a side effect. Commands addressed to a *specific* run or task (`forge show <id>`, `forge report`, `forge bundle`, `forge export`) can't be answered by an empty store, so they fail by name: *no forge store exists on this host yet…*. The store appears on the first command that legitimately writes — a workflow, or a `forge backlog import`.

`forge status` filters by the current workspace by default:

```bash
cd ~/code/my-app
forge status                  # only runs whose workspace matches /Users/you/code/my-app
forge status --all            # every run in the DB, regardless of project + workspace
forge status --workspace <p>  # filter by an explicit workspace path
forge status <run-id>         # explicit lookup, unaffected by filtering
```

A run "matches the current workspace" if either `runs.project_dir == cwd` OR the run's `metadata.workspace == cwd`. The second clause covers the audit-workspace case (see next section). If the cwd-scoped view is empty AND there are runs in other workspaces, the empty-list message tells you:

```
No runs in this workspace. Use --all to see runs from other projects.
```

The dashboard is intentionally NOT scoped — it shows runs across every project, since that's its job as a cross-project survey surface.

## Orchestrator sessions across workspaces

The orchestrator block (installed by `forge init` into a project's `CLAUDE.md`) tells the Claude Code session: "at startup, check for in-flight runs in this workspace." Since `forge status` is workspace-scoped by default, the orchestrator only picks up runs that belong to this project. Don't pass `--all` for this check — foreign runs are owned by whichever workspace started them.

When workspace and project diverge — e.g. running an orchestrator in `~/code/audit-workspace` but driving feature runs against `~/code/forge` — pass `--workspace $(pwd)` to `forge new` / `forge invoke` so the originating workspace gets stamped into `metadata.workspace`. The default is cwd, so most of the time you don't need to set it explicitly; the audit-workspace pattern is the case where it matters. Once stamped, `forge status` in the audit-workspace finds the run even though its `projectDir` points elsewhere.

## Running forge on the forge repo itself

Forge IS its own project. You can run `forge init ~/code/forge` (or `cd ~/code/forge && forge init`) to install the orchestrator block into forge's own `CLAUDE.md`, then use `forge new feature` etc. to evolve forge through the same pipeline it provides to other projects. The forge repo uses the structured backlog format (tickets under `backlog/`, notes at `backlog/notes.md`); `forge backlog list --status active` works from `~/code/forge` like it does from any other project.

**Use the workflow path — `forge new` / `forge next` — for the meta case.** Those provision an isolated workspace per task, so agents never write into the tree forge is running from. `forge invoke` provides no such isolation and is refused here; that is caveat 1.

Four caveats specific to the meta case:

1. **`forge invoke` against the forge checkout itself is refused (FG-612).** `forge invoke <role> --project ~/code/forge` — and `forge review-loop` pointed there, whose reviewer and fixer both dispatch through the same path — mounts the live checkout and provisions no workspace, so agent writes land in the tree this forge is executing from. Since forge runs `src/` in-process, a half-written file is immediately live for every forge process on the host. Forge refuses before the container starts and before the task row exists:

   ```
   forge: REFUSING to dispatch — self-host dispatch on a path that provisions no isolated workspace (FG-612).
     project:            /Users/you/code/forge
     forge source root:  /Users/you/code/forge  (the tree this forge is executing)
   ```

   **Do not reach for `FORGE_WORKTREES=1` — it will not help, and the refusal deliberately never mentions it.** FG-345 made workspace isolation default-on, but that guarantee is a property of *workflow* dispatch; arming the flag does not change what an invoke mounts, so you would land back on the live checkout believing you had fixed it. The refusal is structural, not a missing flag. Two ways through:

   ```bash
   # The fix: dispatch against a disposable clone, outside the forge source root.
   git clone ~/code/forge ~/code/forge-work
   forge invoke engineer --project ~/code/forge-work

   # The override: proceed on the shared checkout anyway, having accepted the hazard.
   # Warns once per project; isolates nothing.
   FORGE_NO_WORKTREES=1 forge invoke engineer --project ~/code/forge
   ```

   This is scoped to the self-host case. `forge invoke` against any *other* project is unaffected and still runs against that project's checkout. See [Workspace isolation](concepts.md#self-host-dispatch-on-a-never-isolated-path) for the full contract.

2. **`forge review-loop` must be pointed at a clone, not at the forge checkout itself (FG-566).** `--project` defaults to cwd, so running the loop from `~/code/forge` targets the very tree the running forge is executing from — and the loop's local verification fallback prepares its workspace by running `npm ci`, which deletes `node_modules` before rebuilding it. That would take out the `better-sqlite3` binding this forge and every concurrent forge on the host are loaded from. Forge therefore refuses, before anything runs, with a classified `self_host_workspace` readiness refusal:

   ```
   review-loop: verification_environment_unavailable: review-loop could not establish an
   execution-ready verification environment in /Users/you/code/forge (self_host_workspace). …

   ✗ not closeable — stop reason: verification_environment_unavailable (self_host_workspace).
   Forge could not establish an execution-ready verification environment in
   /Users/you/code/forge, so NO verification ran: this is NOT a verdict on the reviewed code.
   Rounds consumed: 0; the reviewer was NOT dispatched and the fixer was NOT dispatched.
   ```

   That refusal is **intended**, and it is not a verdict on the code — no reviewer or fixer was dispatched and no round was consumed. There is deliberately no override, and having `node_modules` already installed does not exempt the checkout. Run the loop against a clone outside the forge source root instead:

   ```bash
   git clone ~/code/forge ~/code/forge-review   # once
   git -C ~/code/forge-review fetch origin      # then refresh before each loop run, so the
                                                # clone carries the range under review
   forge review-loop <ticket-id> --project ~/code/forge-review --max-rounds 1 --route <route>
   ```

   This readiness refusal is what fires when the loop reaches its *local* verification arms. When a green required CI check covers `HEAD`, the loop reuses that evidence and never attempts a local install, so it gets past readiness — and then stops at caveat 1 instead, because its reviewer dispatch is a self-host invoke. **Either way the loop cannot run from the forge checkout**, and a clone is the answer to both. See [Host verification readiness](concepts.md#host-verification-readiness) for the full contract and the rest of the refusal vocabulary.
3. **Don't edit forge source files from inside an agent container that has forge mounted at `/project`.** That works — but you're now changing the same binary that's running the run. If the agent edits `src/v2/spawn.ts` and the parent forge process re-spawns a child container mid-run, the source has moved underneath. Use the pipeline for forge changes, but expect to restart any in-flight orchestrator session afterward to pick up the new behavior.
4. **The forge repo's `CLAUDE.md` (the one at the repo root, checked into git) is for sessions WORKING ON forge** — it doesn't contain the orchestrator block. If you want to be orchestrated when developing forge, run `forge init --project ~/code/forge`; the block will be appended after the existing content.
