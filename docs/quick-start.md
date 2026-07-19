# Quick start

End-to-end: install once, then run forge against your project. The walkthrough uses a generic `~/code/my-app` to make it concrete; replace with whichever project you actually want to work on.

## 1. Install (once per machine)

```bash
cd ~/code/forge
npm install
./scripts/install-seeds.sh
./docker/build.sh           # one-time, ~5–10 min
```

`install-seeds.sh` copies the default agent role directories, constraints, runtimes, and workflow YAML into `~/.forge/`, and installs the `forge-*` workflow skills into the user-global Claude skills dir (`~/.claude/skills` by default), so they're available to any Claude Code session on the machine. `docker/build.sh` builds the `agent-dev-worker` image (Ubuntu 22.04 + Node 20 + Claude Code CLI + git/jq/playwright + agent UID 1000).

Now build a release and select it as the machine-wide `forge`. There's no stable `forge` yet on a fresh machine, so this bootstrap runs through `forge-dev`, the live-source entry:

```bash
./bin/forge-dev release build --out ~/forge-releases/r1   # --out must not exist, and must be outside the checkout
./bin/forge-dev release promote ~/forge-releases/r1       # atomic pointer swap; reversible with `forge release rollback`
./bin/forge-dev release install-shim --prefix /usr/local/bin   # once; any directory on your $PATH
```

The three steps are separate on purpose: a build selects nothing, a promotion is an atomic swap of `~/.forge/current` that leaves the previous release selected if the candidate fails validation, and the shim is installed explicitly — a promotion never rewrites it. To upgrade later, build and promote again; the shim resolves `current` at run time and is not reinstalled.

Don't use `npm link` for this. It puts a `forge` on `$PATH` symlinked into your live checkout, which bypasses the release split, the `current` pointer, the pinned interpreter, and the environment sanitization the stable `forge` gives you. Use `./bin/forge-dev` (or `npm run forge -- <cmd>`) when you want to run the live checkout — that entry exists for exactly that, and fails when the checkout is broken by design. Note that stable `forge` also unsets ambient `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS` and peers; see the README if you depend on any of those reaching forge.

Verify: `which forge` should print a path; `forge release current` should name the release you promoted; `forge --help` should list the commands.

After installing, run `forge setup` to create the active model policy from the seed and get a full readiness report before dispatching any agents. Full new-machine checklist: `docs/work-laptop-setup.md`.

## 2. Set up credentials (once per machine)

Three modes (FORGE-DEC-007). Forge auto-selects based on environment:

### Personal Mac (Anthropic Pro, includes Opus 4.7)

```bash
forge auth login
```

This launches an interactive `claude` inside an agent container. Run `/login` at the prompt, follow the browser flow, then `/exit`. Credentials persist in docker volume `forge-claude-oauth` and are reused on every subsequent agent spawn.

Verify with `forge auth status`. To switch accounts, `forge auth logout` then `forge auth login` again.

### Work machine (Bedrock — Sonnet/Haiku, no Opus)

```bash
aws sso login --profile adx-dev
```

That's the only required step. For the interactive session, pass `--bedrock` to `forge claude` instead of sourcing `scripts/use-bedrock.sh` — see the **Bedrock mode via `forge claude`** tip in step 4. For agent dispatches (`forge next`), forge auto-detects Bedrock when `AWS_PROFILE` is set in your shell or when `~/.aws/config` has an SSO-backed default profile.

`scripts/use-bedrock.sh` still works if you want the vars armed in your parent shell (for tools running outside forge). Agent containers read SSO state from a mounted `~/.aws` (RO); see FORGE-DEC-013.

For multi-hour runs the watchdog refreshes silently every 5 minutes via the SSO refresh token — no browser pop unless your refresh token (typically days/weeks) has also expired. `forge claude --bedrock` starts the watchdog automatically for the session; `forge next` starts it at dispatch time. PID is tracked at `~/.forge/sso-watchdog.pid`.

### API key (escape hatch)

```bash
export ANTHROPIC_API_KEY=sk-...
```

## 3. Set up your project (once per project)

```bash
cd ~/code/my-app
forge init
```

This installs the forge orchestrator block into `~/code/my-app/CLAUDE.md` (creating the file if needed), creates a `~/code/my-app/.forge/` directory (provisioning `model-policy.yml` and `docs-surfaces.yml` from bundled seeds when absent), scaffolds a `backlog/` directory (`stories/`, `epics/`, `ideas/`, `done/`, `notes.md`), AND installs two kinds of hooks:

- A `commit-msg` git hook that rejects commits with `Co-Authored-By: Claude` trailers or other AI-attribution boilerplate (defense-in-depth for the `no-ai-attribution` constraint).
- Claude Code session lifecycle hooks (SessionStart / Stop / SessionEnd) wired into `.claude/settings.local.json` (per-developer, gitignored) that write a heartbeat file at `~/.forge/orchestrators/<session-id>.json`. `forge projects list` reads these to show which orchestrators are currently live (●), and the dashboard surfaces the same signal in its Projects view.
- Slash commands `/orient` and `/handoff` symlinked into `.claude/commands/` (per-developer, gitignored). `/orient` runs the start-of-session protocol (notes / active tickets / git state / live sessions) and ends with "What's the priority?" `/handoff` drafts the next-session notes block and applies it via `forge backlog notes replace`. Both hard-code use of the `forge backlog` CLI instead of reading the file whole. See `docs/concepts.md → Slash commands`.
- Entries in `.gitignore` for the two per-developer paths above so they don't get accidentally committed.

**Convention:** `.claude/settings.local.json` and `.claude/commands/` are per-developer (machine-local), because they hold machine-absolute paths into this developer's forge clone. The project's `.claude/settings.json` (if present) stays untouched by forge — it remains available for project-shared config like permissions. New contributors run `forge init` once after cloning, exactly like `npm install` reconstructing `node_modules/`.

Re-run `forge init` any time you upgrade forge — the orchestrator block is fence-marked and replaces in place; the commit-msg hook is a symlink; the Claude hooks are merged into `.claude/settings.local.json` (existing user hooks are preserved, only the forge heartbeat entries get upgraded); slash commands are symlinks so template edits in the forge repo flow to every project on next session; `.gitignore` gets the per-developer entries appended if missing; `backlog/` subdirs and `notes.md` are created if absent; `model-policy.yml` and `docs-surfaces.yml` are provisioned when absent (never overwritten). All re-runs are idempotent. `forge upgrade` performs the same re-init across the current project as step 4, so already-init'd projects pick up new hooks / commands automatically — including auto-migration of projects whose hooks landed in the committed `.claude/settings.json` before this convention shipped.

Use `forge init --prefix FG` (or your project's ticket prefix) to write the prefix to `.forge/config.yml`; `forge backlog` uses it when creating new tickets. Skip all four hook installs with `forge init --no-install-hooks` if you'd rather wire them yourself. Forge never clobbers an existing `commit-msg` hook, an unrelated key in `.claude/settings.local.json`, a project-local `.claude/commands/<name>.md` override (regular file, not a forge symlink), or your `.gitignore`'s existing entries; if `settings.local.json` is unparseable JSON it's left alone with a SKIPPED notice.

## 4. Pick a path: orchestrator-led or direct CLI

After `forge init`, you have two ways to drive forge in this project. They're equally valid and use the same underlying runs/tasks/gates — the difference is who decides which agent to call.

**Orchestrator-led (the conversational path).** Start `claude` in `~/code/my-app` (or `forge claude`, see below). The orchestrator block in `CLAUDE.md` makes that session the project's forge orchestrator. You say *"add OAuth login using the existing user table"*, the orchestrator classifies the request (implementation work), picks the right workflow (`feature`), constructs the brief, calls `forge new feature` for you, watches the run, presents each gate with a recommendation, and reports the final result. You never type a `forge` command yourself. This is the recommended path for ad-hoc work.

**Tip — `forge claude`.** Use `forge claude` instead of bare `claude` and you get: (a) the session display name auto-set to the project's friendly label (shown in prompt box, /resume picker, terminal title); (b) chdir to the project root if invoked from a subdir; (c) a one-line status banner with branch / unpushed commits / active ticket count; (d) pre-flight warnings if the project hasn't been bootstrapped on this machine (missing `.claude/settings.local.json`, stale forge symlinks). All extra args (`--continue`, `--resume`, `--model`, `--add-dir`, etc.) pass through to `claude` unchanged. For fully transparent use, alias it in your shell rc: `alias claude='forge claude'`.

**Bedrock mode via `forge claude`.** Pass `--bedrock` to activate Bedrock without sourcing `scripts/use-bedrock.sh` first. Forge injects `CLAUDE_CODE_USE_BEDROCK=1` and `AWS_PROFILE` into the spawned `claude` process only — your parent shell is never modified:

```bash
forge claude --bedrock
forge claude --bedrock --aws-profile adx-dev    # explicit profile override
```

`--aws-profile` sets which AWS profile to use. When bedrock is active, the profile is resolved in this order: `--aws-profile` flag → `.forge/project.json` `awsProfile` field → `AWS_PROFILE` env var → `"default"`. The resolved profile appears in the launch banner (e.g. `bedrock:adx-dev`). Before launching, forge runs two pre-flight checks scoped to that resolved profile only — never another profile's, so other profiles on the same host can never mark it stale or hide a real staleness. First, it compares the profile's STS cache mtime against its SSO session; if that looks stale, forge confirms against `aws configure export-credentials --profile <profile>` (the same credential path forge injects into the container). Second, forge checks the profile's own SSO token freshness directly (catches profiles that authenticate SSO-direct and never populate the STS cache the first check relies on). Both checks are advisory only: whether the export probe succeeds or fails, forge prints a warning naming the profile — including, for the SSO-freshness check, the expired token's evidence (cache file, raw and timezone-labeled UTC/local expiry, current time) — and the same `aws sso login --profile <profile>` remediation, then launches `claude` anyway; a native `claude`/AWS auth failure is handled by `claude` itself, not forge. This is specific to the interactive `forge claude` launcher — container dispatch (`forge next` / `forge new`) has no interactive fallback, so it still hard-blocks on a failed credential export. The SSO watchdog starts automatically to keep the token fresh.

To persist the auth mode per project, set `auth` in `.forge/project.json`:

```json
{
  "name": "My App",
  "auth": "bedrock",
  "awsProfile": "adx-dev"
}
```

`auth` accepts `"bedrock"`, `"oauth"`, or `"apikey"`. With `auth: "bedrock"` here, `--bedrock` is not needed on every launch and `awsProfile` sits between the flag and the env var in the resolution order above. With `auth: "apikey"`, `forge claude` exits immediately if `ANTHROPIC_API_KEY` is unset.

**Direct CLI (the scripted path).** Run `forge new` / `forge invoke` yourself. Useful when you're automating, repeating the same workflow many times, or driving forge from outside a Claude Code session. Steps 5–8 below walk this path explicitly.

You can mix freely — drive most work conversationally, drop to the CLI for a one-off scripted invocation, then go back to chat.

## 5. Create a run (direct CLI path)

The remaining steps show the direct-CLI walkthrough; if you're using the orchestrator-led path, your `claude` session handles all of this and you can read along for orientation only.

Full feature runs are ticket-backed — the `build` phase's shipping-reviewer red needs a backlog ticket's acceptance criteria to review against, so `forge new feature` requires a `--ticket <id>` (or a campaign, which stamps one automatically). File one first if you don't already have it:

```bash
cd ~/code/my-app
forge backlog file "add OAuth login" --type story
# → FG-42
forge new feature "add login" \
  --brief "wire OAuth into the existing user table; reuse the session middleware" \
  --ticket FG-42
```

Output:
```
Created run run-add-login-7c2a91
Workflow: feature
Title:    add login
Project:  /Users/you/code/my-app

Next:
  forge next run-add-login-7c2a91
```

`forge new` resolves the project mount root before launching any container. When run from inside a git repo, it walks up to the repo root and mounts that (with an informational notice). Agent containers then see the full repo at `/project` (read-write for engineers, read-only for reds). Override with `--project <dir>` to target a specific directory; if that directory is a subdir of a git repo, pass `--allow-subproject` to suppress the automation hard-fail. See FORGE-DEC-022 for the full resolution policy.

## 6. Dispatch the first phase

```bash
forge next run-add-login-7c2a91
```

Forge picks up the pending `architect` task, launches an agent container, captures the result. The architecture-advisor surfaces risks, constraints, and boundaries before the tech-lead plans steps.

This blocks for as long as the agent runs. That's what you want in your own terminal; it is not what you want when a Claude Code session is the one shelling out — see step 13 for `forge launch`, the durable owner for long commands.

While running:
```
Run run-add-login-7c2a91: 1 task(s) running.
  ⟳ task-architect-f68eb8 (architect/architecture-advisor)
```

When done:
```
Run run-add-login-7c2a91: 1 task(s) awaiting gate.
  ⚠ task-architect-f68eb8 (architect)  →  forge gate task-architect-f68eb8 advance | reject | request-changes
```

## 7. Review and gate

```bash
forge show task-architect-f68eb8
```

Shows the diagnostic view for the architect task: status, event timeline, red verdicts (if any), artifacts, and suggested next command. To read the architect's output (decisions, risks, open questions), open the `result.json` listed in the artifacts section. If looks good:

```bash
forge gate task-architect-f68eb8 advance
```

Forge creates the `plan` task under the next phase.

## 8. Continue

```bash
forge next run-add-login-7c2a91
```

The pipeline runs phase-by-phase: architect → tech-lead (plan) → engineer (build, with reds in parallel) → test-engineer (verify) → documentation-maintainer (docs). Gate each step with `advance`, `reject`, or `request-changes --rationale "..."`. The run can't move to the next phase until every sibling is gated.

## 9. End of run

After `docs` completes (auto-gate), the run is marked `complete`.

```bash
forge status run-add-login-7c2a91
```

shows the full task graph with verdicts. Output documents live at `~/.forge/runs/run-add-login-7c2a91/<task-id>/result.json`.

## 10. Status across projects

```bash
forge status                  # runs in the current workspace (cwd-scoped)
forge status --all            # all runs across every project on the host
forge status --workspace <p>  # runs for an explicit workspace path
```

If you're standing in `~/code/my-app` and have runs going in other projects too, the default cwd-scoped view keeps your terminal focused on this project. See `docs/how-to-use-forge-across-projects.md` for the multi-project story.

## 11. Upgrading later

When new forge commits arrive (new agents, workflows, CLI behavior), `forge upgrade` refreshes its forge-owned seeds — `~/.forge/`'s workflows and runtimes, plus the `forge-*` skills in the user-global Claude Code skills dir (`~/.claude/skills`, not `~/.forge/`) — and re-inits the current project in one step. Your operator-authored seeds — agent prompts, constraints, and `forge-raci.md` — are retained, not overwritten (`FORCE=1` included, FG-578); remove the `~/.forge/` copy to re-take a release's version, or merge by hand:

```bash
cd ~/code/my-app
forge upgrade                  # refreshes forge-owned ~/.forge/ seeds from the running release (authored seeds retained), re-inits project; runs release check
forge upgrade --dry-run        # see what would change without doing it (can exit 1)
forge upgrade --json           # the structured result, for scripts
```

**`forge upgrade` exits nonzero whenever something you asked for didn't happen** — not just the release refusal below, but a dirty checkout, a failed `npm install` or `install-seeds.sh`, a RACI that won't compile, a project with no forge block, a failed `--rebuild-image`, or a crashed release check. It prints `Upgrade INCOMPLETE — <reasons>` instead of `Upgrade complete.` and `--json` reports the same states as `ok:false` plus an `unresolved` list. Operator skips (`--skip-git`, `--skip-npm`, `--skip-project`) are *not* failures and exit 0. `--dry-run` follows the same rule, so a dry run can exit 1 too — and a clean one only means nothing decidable *without executing* is wrong. Full contract: `docs/how-to-upgrade.md`.

Upgrade installs the seeds of **whichever forge you ran**: the promoted release under `forge`, your working tree under `forge-dev`. Advancing the checkout is separate — `git pull`, `npm install`, and `--rebuild-image` are dev-checkout work, refused under a release (which exits nonzero and says so). Do those from the checkout:

```bash
cd ~/code/forge
./bin/forge-dev upgrade                  # pull + npm install + refresh ~/.forge/ from your working tree
./bin/forge-dev upgrade --rebuild-image  # also rebuild the agent Docker image (when a build input changed)
```

Moving the machine-wide `forge` onto new commits is still `release build` → `release promote` from an updated checkout (step 1). This step refreshes `~/.forge/` and project state — not the stable `forge` itself.

After the upgrade steps complete, `forge upgrade` automatically runs a read-only release check — image, runtime CLIs, auth credentials, policies, and seed drift — and surfaces any problems before the next dispatch. It is skipped on a `--dry-run`, and skipped (saying so) when the seed install didn't run, since its verdict would describe a `~/.forge` the upgrade never touched. Run `forge doctor` for the full report, or `forge setup` on a new machine to create the active model policy from the seed at the same time.

New machine? See `docs/work-laptop-setup.md` for the full setup checklist.

Full doc: `docs/how-to-upgrade.md` (flags, multi-project loop, manual recipe).

## 12. Dashboard (optional)

The web view ships as an npm workspace in the forge repo (`dashboard/`). Run it either way (FG-580). `forge dashboard` works from a **promoted release** — the dashboard is bundled into the release as a mandatory asset and resolved from the executing release. Its client libraries are vendored as first-party files and the server sends `Content-Security-Policy: script-src 'self'`, so the UI **boots offline** with no CDN-executed JS (its provider/data APIs may still need network). When working from a checkout, use `forge-dev dashboard start` instead:

```bash
# from the stable release
forge dashboard start                        # boots http://127.0.0.1:8024

# from a source checkout
cd ~/code/forge
./bin/forge-dev dashboard start              # boots http://127.0.0.1:8024
./bin/forge-dev dashboard start --port 8025  # custom port
```

Reads `~/.forge/forge.db` directly (read-only — won't contend with `forge next`). Renders agent results as markdown cards by agent type (architect risks, tech-lead plans, engineer diffs, red verdicts). Always cross-project: the dashboard intentionally shows runs across every project on the host (the cross-project survey surface), independent of `forge status`'s workspace filter. Schema contract: `docs/SCHEMA-CONTRACT.md`.

## 13. Long-running commands under an interactive session (`forge launch`)

Steps 6 and 8 dispatch containers that can run for many minutes. When you type `forge next` yourself in a terminal, that's fine — you own the shell. When a **Claude Code session** runs it for you, it is not: the harness SIGTERMs its own registered background tasks on internal sweeps, and an attached `docker run` forwards the signal straight into the agent container, which dies with exit 143 and takes the work with it. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (recommended; a session restart is required for it to take effect) removes background dispatch entirely, which makes the durable path the only path.

`forge launch` is that path. It hands ownership of the process to a tmux server, so the submitting shell — the harness's Bash call — can return, or die, without touching the command. Use it for anything long: `forge next`, `forge invoke`, a review-loop, a full test suite. Requires `tmux` on the host (`brew install tmux` / `apt install tmux`).

```bash
forge launch run --name next -- forge next run-add-login-7c2a91   # returns immediately
forge launch list                                                  # every launch + derived status
forge launch show launch-next-a1b2c3                               # record, forge run/task ids, log tail
forge launch wait launch-next-a1b2c3                               # BLOCK until it reaches a terminal disposition
forge launch rm launch-next-a1b2c3                                 # after it's finished
```

`run` prints the launch id, the tmux session (`tmux attach -t <session>` to watch it live), and the log path. Poll with `show` — or, better, with forge's own durable state (`forge status <run-id>`, the task rows, the dashboard). Never poll by matching process names: the tmux-owned process is not a child of your shell, and forge's DB is the record that survives a session, a reboot, and a kill. `show` (and `list --json` / `show --json`) also reports the launched workload's own provenance — a `workload:` line for the resolved top-level executable (R3) and a `nested:` line for whether the effective runtime is even knowable at launch time (R4). The `nested:` line reads `not applicable` **only** when the effective `argv[0]` is a terminal Node interpreter (`node`/`nodejs`) that IS the runtime; for everything else — a shell (`bash -lc`), a script, or any launcher (`npm`, `npx`, a `#!/usr/bin/env node` binary) whose shebang/PATH resolves Node only *after* `argv[0]` is spawned — it reads `UNKNOWABLE`, because a later resolution may select a different Node. It is **not** a "there is a nested shell" flag: a bare `true`, a `#!/bin/sh` script, and a `vitest` launcher are all UNKNOWABLE without any shell present. So those two lines identify `argv[0]` (R3) and whether a later runtime resolution is unknowable (R4); they do **not** by themselves record the effective Node ABI/version that ran the command. When the workload's `argv[0]` is a probed Node interpreter, the effective runtime is recorded on the `runtime:` line and the pinned launch contract (if any) on the `profile:` line — otherwise those read `not recorded`, never guessed (FG-555; concepts.md "Durable launch").

When a **controller** (an orchestrator or campaign runner) needs to be notified the moment a launch finishes — instead of polling on a fixed estimate — use `forge launch wait <id> [--json] [--timeout <seconds>]`. It **blocks** until the launch reaches a terminal disposition, then emits exactly one structured observation (returning immediately if the launch is already terminal). It watches the atomic exit record and reconciles owner evidence for the no-artifact dispositions (`owner_gone`/`unknown`); it never wakes a model and never fabricates a result — a launch that exited 0 is never reported as `owner_gone`. It is a minimal observer: it resolves with only `node:fs` and the tmux binary, so it still reports even when the native runtime can't load. The **waiter's** exit status is distinct from the launch's own exit code (which is data in the observation): `0` it observed and rendered a disposition (including `owner_gone`/`unknown`), `1` unknown launch id (distinct from a *known* launch whose status is `unknown`), `124` the waiter timed out (an explicit result, never a fabricated launch state), `130` the waiter was cancelled. Interrupting it (SIGINT/SIGTERM) cancels **only the waiter** — it exits `wait_cancelled` and never touches the tmux-owned work, so the launch keeps running.

For a **Forge-owned unattended verification** — a launched command that must run under forge's own compatible toolchain, e.g. `forge launch run --require-control-toolchain -- forge review-loop …` or a test chain the orchestrator submits — pass `--require-control-toolchain`. The contract **pins the workload's `PATH` to forge's control-runtime node dir (the control node first)** and decides *before executing* whether to run or refuse. It **allows** a **direct**, name-resolved control tool — `forge …` / `npm …` / `npx …` resolved **by name** anywhere on the pinned `PATH` (the pin puts the control node first, so the tool runs under it), or a `node`/`nodejs` (by name or an explicit path) whose ABI matches the required ABI (e.g. Node 24/ABI 137). This is what makes submitting the verification as a plain `forge review-loop …`, `npm run …`, or `node …` command work directly. Before matching it skips leading `VAR=VAL` assignments and a bounded set of recognized **non-PATH-mutating** exec-prefixes (`env`/`nice`/…), so a form like `env FOO=bar node …` is still allowed when the effective command is provable. Everything else is **refused**: a **login shell** (`bash -lc`, `zsh --login`) that re-sources profile and resets `PATH` after the pin; any wrapper that mutates `PATH` (e.g. `env PATH=…`); an interpreter whose ABI differs; a control tool given by **explicit path** (not name-resolved); and any **other shell** (even non-login — `bash -c`, `sh -c`), script, or unknown wrapper. The refusal is a single named, actionable message telling you to resubmit the verification as a **direct** `forge`/`npm`/`node` command on the pinned toolchain — no shell, no env/PATH wrapper. It only *probes* the ABI; it never rebuilds a native dependency. This fails a toolchain skew *here* instead of deep in the suite with opaque `ERR_DLOPEN_FAILED`. **Honest boundary:** a name-resolved `npm`/`npx` is trusted to **start** under the pinned control node, but the contract does **not** deep-verify `npm run` lifecycle-script node resolution — `npm run` prepends the project's `node_modules/.bin` to the lifecycle `PATH`, so a project-provided `node` there could resolve a different ABI *after* the gate. That later resolution is recorded R4 `unknowable`, not guaranteed. For a strict guarantee, launch `node`/`forge` directly rather than via an `npm run` lifecycle script. Operators running `forge launch` themselves don't need the flag — without it, `forge launch` behaves exactly as before: it inherits the ambient env, runs and records the workload, and makes no toolchain claim.

Status is derived when you read it, not stored, so it stays honest about what forge can actually prove:

```
launch-next-a1b2c3   running                                                            started 2026-07-11T22:04:11Z  — forge next run-add-login-7c2a91
launch-tests-9f0e21  exited 0                                                           started 2026-07-11T21:38:02Z  — npm test
launch-loop-4c7d10   terminated by SIGTERM (signal sender not recorded — origin unknown)  started 2026-07-11T20:11:57Z  — forge review-loop
launch-build-2e5b77  exited 143 (signal-range code, no signal evidence — origin unknown)  started 2026-07-11T19:44:30Z  — npm run build
launch-inv-3d9c05    owner gone without an exit record (wrapper killed, or failed before recording — cause and sender not recorded)  started 2026-07-11T19:02:18Z  — forge invoke red-team
launch-next-88ab04   unknown (no exit record, owner gone — e.g. host reboot)             started 2026-07-10T18:02:44Z  — forge next run-atlas-audit-51ff08
```

The wrapper records the OS's verdict, so the four failure lines say four different things. `terminated by SIGTERM` means the kernel really did kill the command; nothing records *who* sent the signal, so forge names the signal and makes no claim about the sender. `exited 143` means the command returned a signal-range code with no signal evidence behind it — a command is free to return 143 on purpose, so forge reports the code rather than upgrading it to a kill. `owner gone without an exit record` means the tmux pane is dead but no exit record was ever written — the wrapper writes one even for a signaled child, so that shape proves the wrapper never finished its last act, but not *why*: it may have been killed, or it may have died on an I/O failure while writing the record. Forge names the shape and makes no claim about either the cause or a sender. `unknown` means the exit record and the tmux session are both gone (a host reboot), and forge says so rather than guessing that the command succeeded or failed. `forge launch rm` refuses a launch that is still *running* unless you pass `--force`; an owner-gone launch is terminal by evidence, so `rm` cleans it up without one, and cleanup still can't be the thing that kills a live run.

Concept reference: `docs/concepts.md` → **Durable launch**.
