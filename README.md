<p align="left">
  <img src="./assets/logo-wordmark.svg" alt="forge" width="320">
</p>

A TypeScript CLI for orchestrating multi-agent AI workflows on a personal machine. Forge runs on the host; each agent runs as an ephemeral Docker container. SQLite is the blackboard. Core CLI: `init`, `new`, `next`, `gate`, `show`, `status`, `invoke`, `backlog`, `launch` (durable tmux owner for long-running commands), plus `auth` for personal-Mac OAuth.

Forge is host-global: one install, one `~/.forge/forge.db`, used against any project on the machine. Each project gets a per-project setup (`forge init`) that wires the orchestrator block into its `CLAUDE.md`, creates a `.forge/` directory for project-level workflow overrides, and scaffolds a `backlog/` directory so `forge backlog` commands work immediately.

The web view ships as a workspace package (`dashboard/`) — boot with `forge-dev dashboard start` from a checkout of this repo (it isn't bundled into a release; see [Dashboard](#dashboard)). It reads `~/.forge/forge.db` directly and renders agent outputs across all projects on the host.

## Prerequisites

A Node whose ABI (`NODE_MODULE_VERSION`) is exactly 137 — the Node pinned in `.nvmrc` (currently 24 — `nvm use` in the repo root) is the supported way to get one. Plus Docker, and one of three auth modes (FORGE-DEC-007). The requirement is an exact ABI rather than a minimum version: forge's better-sqlite3 binding loads only under the ABI it was compiled for, so a newer Node is as incompatible as an older one and forge refuses to start on either. Forge's preflight checks the ABI, not the version string, so any Node release on ABI 137 will start; only the `.nvmrc` pin is tested and supported. Forge auto-selects: `CLAUDE_CODE_USE_BEDROCK=1` → bedrock (work); else `ANTHROPIC_API_KEY` set → apikey; else oauth (`forge auth login` once on personal Macs).

## Install once

Forge ships two entry points on purpose. `forge` is the **stable, machine-wide** command: a promoted, immutable release run by its own pinned interpreter. `forge-dev` is the **live-source** command: it runs whatever is in your checkout right now. Install the stable one; reach for the dev one when you're changing forge itself.

```bash
cd ~/code/forge
npm install
./scripts/install-seeds.sh       # populates ~/.forge/agents, constraints, runtimes, workflows; installs forge-* skills into ~/.claude/skills
./docker/build.sh                # one-time agent image build
```

Now build a release, select it, and put the machine-wide `forge` on `$PATH`. On a fresh machine there is no stable `forge` yet, so this bootstrap runs through the live-source entry:

```bash
./bin/forge-dev release build --out ~/forge-releases/r1   # --out must not exist, and must be outside the checkout
./bin/forge-dev release promote ~/forge-releases/r1       # atomically selects it as the machine-wide forge
./bin/forge-dev release install-shim --prefix /usr/local/bin   # once; pick any directory on your $PATH
forge auth login                 # one-time, personal Mac only (skip if using Bedrock)
```

`which forge` should now resolve, and `forge release current` should name the release you promoted. You won't need to be in `~/code/forge` to run forge from this point on.

Each step is separate because each is a distinct decision. **Building** produces an immutable release directory and selects nothing. **Promotion** is an atomic pointer swap (`~/.forge/current`) — a release that fails validation leaves the previous one selected and reports a refusal rather than a half-install, and `forge release rollback` swaps back to the previously selected release the same way. Promotion deletes nothing, so a rollback target is always still there. **Installing the shim** is explicit and one-time: the shim lives outside the release closure (otherwise a bad promotion would brick the `forge` you need in order to roll back), so a promotion never installs or rewrites it.

To upgrade the stable forge later, repeat build → promote from an updated checkout. You do not reinstall the shim; it resolves `current` at run time.

> **`npm link` is no longer the way to install forge, and will break the guarantees above.** `package.json` declares both `forge` and `forge-dev`, so `npm link` puts a `forge` on `$PATH` that symlinks straight into your live checkout. That `forge` bypasses the release split entirely: no `current` pointer, no atomic promote/rollback, no pinned interpreter, and no environment sanitization. It also shadows or overwrites a shim installed into the same prefix.

### Running the live checkout

```bash
./bin/forge-dev <cmd>            # or: npm run forge -- <cmd>
```

`forge-dev` is deliberately preserved: it runs the code in your working tree with no build and no promotion step, which is the whole point of the dev loop. It is equally deliberate that it **fails when your checkout is broken** — that's it doing its job, not a bug. It resolves `node` from `$PATH` rather than pinning one, because a dev checkout has node by construction.

Be aware that stable `forge` and `forge-dev` are **different artifacts with different provenance**: one runs a frozen release built from a committed tree, the other runs your live source under whichever node your shell finds. A bug that reproduces under only one of them is entirely possible, and worth stating in a report. `forge release provenance` prints what the running process actually is, including its release id (the dev entry has no manifest, so it reports no release id — that's the honest answer, not a gap).

### Environment sanitization (behavior change)

Stable `forge` **neutralizes ambient Node injection variables before the pinned interpreter starts**: `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_COMPILE_CACHE`, `NODE_ICU_DATA`, `NODE_V8_COVERAGE`, `NODE_DEBUG`, the `NODE_PRESERVE_SYMLINKS` pair, and peers (the full list, with the rationale for each, is `SANITIZED_ENV_VARS` in `src/v2/release.ts`).

**If you rely today on `NODE_OPTIONS` or a custom CA reaching forge, that will stop working under the stable `forge`.** This is intended — those variables can run code inside the forge process, redirect module resolution, or move TLS trust before forge's first line executes, which would defeat the pinned interpreter. The unset list is bounded, not a wholesale wipe: `PATH`, `HOME`, `FORGE_HOME`, `AWS_*`, `NTFY_*`, `TERM`, locale and the rest of your environment are untouched, since forge's own auth and notification paths read them. If you need one of the sanitized variables for local debugging, use `forge-dev`.

## Use anywhere

```bash
cd ~/code/my-app
forge init                       # one-time per project; installs orchestrator block, creates .forge/, scaffolds backlog/
```

After `forge init`, you have two ways to drive forge in this project:

**Orchestrator-led (recommended for most work).** Open `claude` in the project directory. The orchestrator block that `forge init` added to `CLAUDE.md` tells the Claude Code session to classify your request and route it through the right forge agent or workflow. You describe what you want in plain English; the orchestrator picks the agent, calls `forge invoke` or `forge new` for you, watches the result, and reports back. You don't have to remember workflow names or flags.

**Direct CLI.** Run `forge new` or `forge invoke` yourself. Useful for scripting, automation, or when you already know which workflow + flags you want:

```bash
forge new feature "add login" --brief "wire OAuth into the existing user table" --ticket FG-123
forge next run-add-login-<suffix>
forge gate task-architect-<suffix> advance
forge next run-add-login-<suffix>
```

Both paths record `projectDir = cwd` on the run; agent containers mount it at `/project`. `forge status` (no args) shows runs for the current workspace; `forge status --all` shows runs across every project.

Full walkthrough: `docs/quick-start.md`. Multi-project specifics: `docs/how-to-use-forge-across-projects.md`.

## Dashboard

The web view ships as an npm workspace inside this repo (`dashboard/`).

Run it **from a source checkout**, not from the stable `forge`: the dashboard is a separate workspace with its own dependency tree and is not bundled into a release, so `forge dashboard` refuses in release mode rather than pretending to run (bundling it is deferred to FG-572).

```bash
cd ~/code/forge
./bin/forge-dev dashboard start              # boots http://127.0.0.1:8024
./bin/forge-dev dashboard start --port 8025  # custom port
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
| `~/.forge/current` | Symlink to the release the machine-wide `forge` runs (`forge release promote` swaps it) |
| `~/.forge/previous` | Symlink to the previously selected release (`forge release rollback` returns to it) |
| `~/.forge/releases/<id>/` | Promoted release closures — immutable, retained (promotion deletes nothing) |
| `~/.forge/interpreters/` | The interpreter store: the pinned nodes releases exec, keyed by version+ABI |
| `~/.forge/runs/<run-id>/` | Per-task packages, results, stderr |
| `~/.forge/launches/<id>/` | Durable launch records: command, tmux session, log, exit code (`forge launch`) |
| `<project>/.forge/workflows/<name>.yml` | Optional per-project workflow override |
| `<project>/CLAUDE.md` | Per-project orchestrator block (installed by `forge init`) |

## Upgrading

When forge has new commits, run `forge upgrade` from any project. It pulls the forge repo, runs `npm install`, refreshes `~/.forge/` seeds, and re-inits the current project's orchestrator block — then a read-only release check runs automatically (image, runtime CLIs, auth, policies, seed drift). To also rebuild the agent Docker image in the same command, add `--rebuild-image`. See `docs/how-to-upgrade.md` for all flags and the multi-project flow.

Note that `forge upgrade` refreshes the **checkout** and `~/.forge/` seeds — it does not build or promote a release, so the stable machine-wide `forge` keeps running the release you last promoted until you `forge release build` and `forge release promote` again.

## Docs

`docs/concepts.md` (glossary), `docs/quick-start.md` (end-to-end), `docs/how-to-use-forge-across-projects.md` (multi-project setup), `docs/how-to-upgrade.md` (refresh after forge changes), `docs/how-to-set-up-notifications.md` (SMS + push notifications when workflows finish), `docs/how-to-ntfy.md` (self-hosting ntfy for push notifications), `docs/how-to-iterm-tint.md` (auto-tint iTerm2 background per project), and `docs/how-to-*.md` for adding new agents/workflows.
