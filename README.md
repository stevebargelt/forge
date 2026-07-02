<p align="left">
  <img src="./assets/logo-wordmark.svg" alt="forge" width="320">
</p>

A TypeScript CLI for orchestrating multi-agent AI workflows on a personal machine. Forge runs on the host; each agent runs as an ephemeral Docker container. SQLite is the blackboard. Core CLI: `init`, `new`, `next`, `gate`, `show`, `status`, `invoke`, `backlog`, plus `auth` for personal-Mac OAuth.

Forge is host-global: one install, one `~/.forge/forge.db`, used against any project on the machine. Each project gets a per-project setup (`forge init`) that wires the orchestrator block into its `CLAUDE.md`, creates a `.forge/` directory for project-level workflow overrides, and scaffolds a `backlog/` directory so `forge backlog` commands work immediately.

The web view ships as a workspace package (`dashboard/`) — boot with `forge dashboard start`. It reads `~/.forge/forge.db` directly and renders agent outputs across all projects on the host.

## Prerequisites

Node 20+, Docker, and one of three auth modes (FORGE-DEC-007). Forge auto-selects: `CLAUDE_CODE_USE_BEDROCK=1` → bedrock (work); else `ANTHROPIC_API_KEY` set → apikey; else oauth (`forge auth login` once on personal Macs).

## Install once

```bash
cd ~/code/forge
npm install
npm link                         # puts `forge` on $PATH
./scripts/install-seeds.sh       # populates ~/.forge/agents, constraints, runtimes, workflows; installs forge-* skills into ~/.claude/skills
./docker/build.sh                # one-time agent image build
forge auth login                 # one-time, personal Mac only (skip if using Bedrock)
```

After `npm link`, `which forge` should resolve. You won't need to be in `~/code/forge` to run forge from this point on.

## Use anywhere

```bash
cd ~/code/my-app
forge init                       # one-time per project; installs orchestrator block, creates .forge/, scaffolds backlog/
```

After `forge init`, you have two ways to drive forge in this project:

**Orchestrator-led (recommended for most work).** Open `claude` in the project directory. The orchestrator block that `forge init` added to `CLAUDE.md` tells the Claude Code session to classify your request and route it through the right forge agent or workflow. You describe what you want in plain English; the orchestrator picks the agent, calls `forge invoke` or `forge new` for you, watches the result, and reports back. You don't have to remember workflow names or flags.

**Direct CLI.** Run `forge new` or `forge invoke` yourself. Useful for scripting, automation, or when you already know which workflow + flags you want:

```bash
forge new feature "add login" --brief "wire OAuth into the existing user table"
forge next run-add-login-<suffix>
forge gate task-architect-<suffix> advance
forge next run-add-login-<suffix>
```

Both paths record `projectDir = cwd` on the run; agent containers mount it at `/project`. `forge status` (no args) shows runs for the current workspace; `forge status --all` shows runs across every project.

Full walkthrough: `docs/quick-start.md`. Multi-project specifics: `docs/how-to-use-forge-across-projects.md`.

## Dashboard

The web view ships as an npm workspace inside this repo (`dashboard/`). One install, one binary.

```bash
forge dashboard start              # boots http://127.0.0.1:8024
forge dashboard start --port 8025  # custom port
```

Shows agent outputs across every project on the host, live-polling every 2s. Reads `~/.forge/forge.db` directly (read-only); mutating actions shell to `forge` so the CLI's auth + validation stay the single entrypoint for state changes. Schema coupling between forge and the dashboard is enforced via TypeScript imports (`dashboard/src/queries.ts` re-exports forge's `Run`/`Task` types from `@forge/types`); see `docs/SCHEMA-CONTRACT.md` for the full contract.

## Where things live

| Path | Purpose |
|---|---|
| `src/` | TypeScript source: cli, notify, ops, raci, store, types, util, v2 (runner primitives) |
| `dashboard/` | Web dashboard workspace (server + client + design corpus) |
| `seeds/` | Default agent dirs, constraints, runtimes, workflows (copied into `~/.forge/`) |
| `docker/agent-dev-worker.Dockerfile` | Agent container image |
| `docs/` | How-tos and concepts |
| `learnings/` | ADRs and patterns for forge itself |
| `~/.forge/forge.db` | SQLite blackboard (host-global; one DB across all projects) |
| `~/.forge/runs/<run-id>/` | Per-task packages, results, stderr |
| `<project>/.forge/workflows/<name>.yml` | Optional per-project workflow override |
| `<project>/CLAUDE.md` | Per-project orchestrator block (installed by `forge init`) |

## Upgrading

When forge has new commits, run `forge upgrade` from any project. It pulls the forge repo, runs `npm install`, refreshes `~/.forge/` seeds, and re-inits the current project's orchestrator block — then a read-only release check runs automatically (image, runtime CLIs, auth, policies, seed drift). To also rebuild the agent Docker image in the same command, add `--rebuild-image`. See `docs/how-to-upgrade.md` for all flags and the multi-project flow.

## Docs

`docs/concepts.md` (glossary), `docs/quick-start.md` (end-to-end), `docs/how-to-use-forge-across-projects.md` (multi-project setup), `docs/how-to-upgrade.md` (refresh after forge changes), `docs/how-to-set-up-notifications.md` (SMS + push notifications when workflows finish), `docs/how-to-ntfy.md` (self-hosting ntfy for push notifications), `docs/how-to-iterm-tint.md` (auto-tint iTerm2 background per project), and `docs/how-to-*.md` for adding new agents/workflows.
