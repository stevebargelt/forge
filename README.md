<p align="left">
  <img src="./assets/logo-wordmark.svg" alt="forge" width="320">
</p>

A TypeScript CLI for orchestrating multi-agent AI workflows on a personal machine. Forge runs on the host; each agent runs as an ephemeral Docker container. SQLite is the blackboard. Core CLI: `init`, `new`, `next`, `gate`, `show`, `status`, `invoke`, `backlog`, `launch` (durable tmux owner for long-running commands), plus `auth` for personal-Mac OAuth.

Forge is host-global: one install, one `~/.forge/forge.db`, used against any project on the machine. Each project gets a per-project setup (`forge init`) that wires the orchestrator block into its `CLAUDE.md`, creates a `.forge/` directory for project-level workflow overrides, and scaffolds a `backlog/` directory so `forge backlog` commands work immediately.

The web view ships as a workspace package (`dashboard/`) and is bundled into every promoted release, so `forge dashboard` runs from the stable `forge`; use `forge-dev dashboard start` when working from a checkout (see [Dashboard](#dashboard)). It reads `~/.forge/forge.db` directly and renders agent outputs across all projects on the host.

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
forge upgrade --skip-project     # REQUIRED — publishes the seed generation dispatch reads (see below)
forge setup                      # author the active model policy (asks, or generates from flags — seed fallback) + routing policy, then run the readiness check
```

`which forge` should now resolve, and `forge release current` should name the release you promoted. You won't need to be in `~/code/forge` to run forge from this point on.

**`forge upgrade --skip-project` is not optional on a fresh host.** `install-seeds.sh` writes only the flat `~/.forge/` copies, and since FG-583 those are **not** a dispatch source — every dispatch reads exclusively the atomic *seed generation* that `forge upgrade` publishes. Until that first generation is published the host fails closed: `forge next`, gate advances, and campaign items refuse with a named, repairable no-generation state (`forge doctor` reports it as `Seed install: NOT INSTALLED`). So publish it here, before `forge setup`. The same command is also the only thing that publishes the **Forge-owned agent protocols** — `seeds/agent-protocols/<role>.md`, the review contract each dispatched reviewer is judged by, which since FG-654 rides inside that same generation rather than in `~/.forge/agents/<role>/CLAUDE.md` (a separate file, forge-owned and always-upgraded in its own right since FG-777). `install-seeds.sh` writes no protocol at all, so the script alone leaves the review lifecycle's nine roles refusing to dispatch, by name, until an upgrade publishes them. (On a release host `forge upgrade` also refuses the `git pull` / `npm install` advancement half and closes `INCOMPLETE` — the asset half that publishes both still runs; add `--skip-git --skip-npm` for a clean exit.)

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

**Orchestrator-led (recommended for most work).** Open `claude` in the project directory (or run `forge claude`/`forge orchestrator` — see below). The orchestrator block that `forge init` added to `CLAUDE.md` tells the Claude Code session to classify your request and route it through the right forge agent or workflow. You describe what you want in plain English; the orchestrator picks the agent, calls `forge invoke` or `forge new` for you, watches the result, and reports back. You don't have to remember workflow names or flags.

`forge orchestrator` resolves which interactive CLI to launch — Claude Code or Codex — from the same effective `model-policy.yml` that already selects models for containerized agents; `forge claude` is the explicit Claude Code shortcut. See `docs/how-to-orchestrator-launcher.md` for the full launcher surface, including how to make Codex the default with one policy line, and exactly what Codex does and does not support relative to Claude.

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

Run it either way (FG-580). `forge dashboard` works from a **promoted release**: the dashboard is bundled into the release as a mandatory asset (a build from a source without `dashboard/`, or with a dirty dashboard/vendored asset, refuses by name), resolved from the executing release rather than your checkout. Its client libraries (preact/htm/marked) are vendored as first-party files and the server sends `Content-Security-Policy: script-src 'self'`, so the UI **boots offline** with no CDN-executed JS — the dashboard's provider/data APIs may still need network. When working from a checkout, use `forge-dev dashboard start` instead:

```bash
# from the stable release
forge dashboard start                        # boots http://127.0.0.1:8024

# from a source checkout
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
| `seeds/` | Default agent dirs, constraints, runtimes, workflows (copied into `~/.forge/`), and `forge-*` skills (installed into the user-global Claude Code skills dir) |
| `docker/agent-dev-worker.Dockerfile` | Agent container image |
| `docs/` | Operator guides, contracts, and indexed design history |
| `learnings/` | ADRs and patterns for forge itself |
| `~/.forge/forge.db` | SQLite blackboard (host-global; one DB across all projects) |
| `~/.forge/current` | Symlink to the release the machine-wide `forge` runs (`forge release promote` swaps it) |
| `~/.forge/previous` | Symlink to the previously selected release (`forge release rollback` returns to it) |
| `~/.forge/releases/<id>/` | Promoted release closures — immutable, retained (promotion deletes nothing) |
| `~/.forge/interpreters/` | The interpreter store: the pinned nodes releases exec, keyed by version+ABI |
| `~/.forge/runs/<run-id>/` | Per-task packages, results, stderr |
| `~/.forge/backlog-snapshots/<task-id>/` | Per-task backlog snapshot published for an agent container's read-only ticket mount |
| `~/.forge/launches/<id>/` | Durable launch records: command, tmux session, log, exit code (`forge launch`) |
| `<project>/.forge/workflows/<name>.yml` | Optional per-project workflow override |
| `<project>/CLAUDE.md` | Per-project orchestrator block (installed by `forge init`) |

## Upgrading

`forge upgrade` refreshes its forge-owned seeds — `~/.forge/`'s workflows and runtimes, plus the `forge-*` skills installed into the user-global Claude Code skills dir (`~/.claude/skills`, not `~/.forge/`) — and re-inits the current project's orchestrator block, then runs a read-only release check automatically (image, runtime CLIs, auth, policies, seed drift). Since FG-777, agent prompts, constraints, and `forge-raci.md` join that forge-owned tier too: FORCE overwrites them exactly as it overwrites a runtime, and they are **ALWAYS upgraded**, not seeded once. That overwrite is gated on a one-time host-edit backup (FG-776) that runs before the first flip: it copies any host authored file you had edited to `$FORGE_HOME/pre-upgrade-backup/<timestamp>/` and prints how to re-express it as a project override — customization now lives in `<project>/.forge` (an agent addendum, a constraint union, a RACI override), which upgrade never touches. A genuine operator edit is never destroyed. That is whole-file, with no carve-out: since FG-654 the **Forge-owned review protocol** the lifecycle's reviewers are judged by lives in the published seed generation (`agent-protocols/<role>.md`), not inside your agent seed, and compose puts it ahead of your prose at dispatch. One consequence for hosts seeded before that change: an agent seed that still carries an embedded copy of the protocol is refused by name — since FG-777 the next `forge upgrade` clears it automatically (the same run's FORCE overwrite replaces the whole file), or you can still delete that section by hand if you'd rather not wait. See `docs/how-to-upgrade.md`. It installs the bytes of **whichever forge you ran** — the promoted release under `forge`, your working tree under `forge-dev` — never `~/code/forge` behind your back.

Advancing the checkout is the other half, and it follows the same stable/dev split as the entry points themselves: `git pull`, `npm install`, and `--rebuild-image` are dev-checkout work, so run them through `forge-dev upgrade` from the checkout. Under the stable `forge` they are **refused** by name and the command exits nonzero rather than reporting success.

```bash
forge upgrade --skip-project     # refresh forge-owned ~/.forge/ seeds from the running release (needs no checkout)
forge-dev upgrade                # from ~/code/forge: also pull, npm install, re-init this project
```

Because seed installation is release-owned, `forge upgrade` repairs a drifted `~/.forge/` — its forge-owned seeds, which since FG-777 include agents, constraints, and `forge-raci.md` — on a machine that has never cloned forge. A diverged copy of those three is **retained, not repaired**, only until the one-time host-edit backup above has run on this host; once it has, `forge upgrade` overwrites them like any other forge-owned seed. The Forge-owned agent protocols are always repaired rather than retained, because they are not in your files: a protocol that is missing, torn, or behind the running release fails `forge doctor` and makes the review lifecycle's roles refuse to dispatch until `forge upgrade` republishes the generation. One protocol state upgrade cannot repair — a release that itself carries no protocol for a covered role, which is the executing tree's problem rather than this host's, so reinstall the release; publication refuses that same missing file. (An embedded legacy copy left inside an agent seed used to be a second unrepairable state; since FG-777 `forge upgrade` clears it too, as a side effect of the same FORCE overwrite.)

`forge upgrade` exits nonzero whenever any requested step did not happen — a refusal, a dirty checkout, a failed install, a stale routing policy, a project with no forge block, a crashed release check — and closes `Upgrade INCOMPLETE — <reasons>` instead of `Upgrade complete.` Operator skips are not failures. `--json` reports the same states as `ok` plus an `unresolved` list, so scripts and humans cannot disagree about whether an upgrade did what was asked. See `docs/how-to-upgrade.md` for all flags, the exit-code and `--json` contract, the execution-mode split, and the multi-project flow.

Note that `forge upgrade` refreshes `~/.forge/`'s forge-owned seeds — it does not build or promote a release, so the stable machine-wide `forge` keeps running the release you last promoted until you `forge release build` and `forge release promote` again.

## Docs

Start with the [documentation index](docs/README.md). It separates current
operator guides and contracts from historical PRDs, implementation plans,
research, and decision records. For the interactive orchestrator launcher
(`forge orchestrator` / `forge claude`, Claude vs. Codex, and the failure/resume
behavior around them), see
[docs/how-to-orchestrator-launcher.md](docs/how-to-orchestrator-launcher.md).
