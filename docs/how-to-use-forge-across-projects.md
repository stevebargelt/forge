# Using forge across projects

Forge is host-global: one install, one `~/.forge/forge.db`, used against any project on the machine. This doc covers the multi-project story — install path, per-project setup, where state lives, how runs and `forge status` scope across projects, and the meta-case of running forge on the forge repo itself.

## Install once

```bash
cd ~/code/forge
npm install
npm link                         # puts `forge` on $PATH
./scripts/install-seeds.sh
./docker/build.sh                # one-time agent image build
forge auth login                 # personal Mac only
```

After `npm link`, `which forge` resolves and `forge --help` runs from any directory. Source files in `~/code/forge/src/` are live (no rebuild needed) since the bin entry runs through `tsx`.

`install-seeds.sh` also installs the `forge-*` workflow skills (`forge-campaign`, `forge-review-loop`, `forge-backlog`, `forge-research-synthesis`) into the user-global Claude skills dir (`~/.claude/skills` by default; override with `CLAUDE_SKILLS_DEST` or `CLAUDE_CONFIG_DIR`). Because that's a Claude Code user setting rather than a forge project setting, the skills become available in **every** project on the machine after a single install — no per-project step needed. These are host/orchestrator skills; container agents don't see them (they use the separate container-only skill mount in `src/v2/spawn.ts`).

To remove: `cd ~/code/forge && npm unlink`.

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

- *"Add OAuth login using the existing user table"* → orchestrator classifies as implementation, runs `forge new feature "add-oauth-login" --brief "..."`, watches the architect → plan → build → verify → docs pipeline, presents each gate, lands the commit.
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
| `~/.claude/skills/forge-*/` | Host/orchestrator workflow skills | Host-global; not seen by container agents |
| `<project>/CLAUDE.md` | Orchestrator block (installed by `forge init`) | Per-project |
| `<project>/.forge/workflows/*.yml` | Per-project workflow override | Per-project |

Per-project state is intentionally minimal: just the orchestrator block and an optional workflow override. Everything else is one install for the whole machine.

## Per-project workflow overrides

If `<project>/.forge/workflows/<name>.yml` exists, `forge new <name>` uses it instead of `~/.forge/workflows/<name>.yml`. Useful when a project needs a non-default phase sequence, an extra red, or a different model alias for a step.

Most projects don't need this; the default workflows in `seeds/workflows/` cover the common cases. When you do need it, copy the seed into the project's `.forge/workflows/` and edit there:

```bash
cd ~/code/my-app
cp ~/.forge/workflows/feature.yml .forge/workflows/feature.yml
# edit .forge/workflows/feature.yml to taste
forge new feature "X" --brief "..."
```

The loader logs which YAML it picked, so you can confirm the override is taking effect.

## One forge.db, many projects

A single SQLite DB at `~/.forge/forge.db` holds runs and tasks from every project on the host. Each run records its `projectDir` at creation time (default: cwd; override: `--project <dir>`).

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

Forge IS its own project. You can run `forge init ~/code/forge` (or `cd ~/code/forge && forge init`) to install the orchestrator block into forge's own `CLAUDE.md`, then use `forge invoke engineer`, `forge new feature`, etc. to evolve forge through the same pipeline it provides to other projects. The forge repo uses the structured backlog format (tickets under `backlog/`, notes at `backlog/notes.md`); `forge backlog list --status active` works from `~/code/forge` like it does from any other project.

Two caveats specific to the meta case:

1. **Don't edit forge source files from inside an agent container that has forge mounted at `/project`.** That works — but you're now changing the same binary that's running the run. If the agent edits `src/v2/spawn.ts` and the parent forge process re-spawns a child container mid-run, the source has moved underneath. Use the pipeline for forge changes, but expect to restart any in-flight orchestrator session afterward to pick up the new behavior.
2. **The forge repo's `CLAUDE.md` (the one at the repo root, checked into git) is for sessions WORKING ON forge** — it doesn't contain the orchestrator block. If you want to be orchestrated when developing forge, run `forge init --project ~/code/forge`; the block will be appended after the existing content.
