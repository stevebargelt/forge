# forge

A TypeScript CLI for orchestrating multi-agent AI workflows on a personal machine. Forge runs on the host; each agent runs as an ephemeral Docker container. SQLite is the blackboard. Core CLI: `new`, `next`, `gate`, `show`, `status`, plus `auth` for personal-Mac OAuth and `dashboard` for the read-only web view.

## Prerequisites

Node 20+, Docker, and one of three auth modes (FORGE-DEC-007). Forge auto-selects: `CLAUDE_CODE_USE_BEDROCK=1` → bedrock (work); else `ANTHROPIC_API_KEY` set → apikey; else oauth (`forge auth login` once on personal Macs).

## Quick start

```bash
cd ~/code/forge
npm install
./scripts/install-seeds.sh       # populates ~/.forge/agents and ~/.forge/constraints
./docker/build.sh                # one-time agent image build
./bin/forge auth login           # one-time, personal Mac only (skip if using Bedrock)

./bin/forge new investigation "litellm-evaluation" \
  --question "Does LiteLLM solve provider routing and aggregate cost tracking for our harness?"
./bin/forge next run-litellm-evaluation-<suffix>
./bin/forge gate task-frame-<suffix> advance
./bin/forge next run-litellm-evaluation-<suffix>
```

Full walkthrough: `docs/quick-start.md`.

## Dashboard

```bash
./bin/forge dashboard            # default port 3737
./bin/forge dashboard --port 8080
```

Open `http://127.0.0.1:3737`. Read-only web view of all runs, tasks, verdicts, and gate decisions backed by the same `~/.forge/forge.db` the CLI uses. Renders agent markdown reports as HTML. Safe to run alongside an active run — the dashboard opens the DB read-only and never blocks `forge next` (FORGE-DEC-012). Refresh the page to pick up new state; there are no live updates today.

## Where things live

| Path | Purpose |
|---|---|
| `src/` | TypeScript source: types, store, spine, CLI |
| `seeds/` | Default agent dirs and constraints (copied into `~/.forge/`) |
| `docker/agent-dev-worker.Dockerfile` | Agent container image |
| `docs/` | How-tos and concepts |
| `learnings/` | ADRs and patterns for forge itself |
| `~/.forge/forge.db` | SQLite blackboard (runtime) |
| `~/.forge/runs/<run-id>/` | Per-task packages, results, stderr |

## Docs

`docs/concepts.md` (glossary), `docs/quick-start.md` (end-to-end), and `docs/how-to-*.md` for each workflow type and for adding new agents/workflows.
