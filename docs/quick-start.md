# Quick start

End-to-end: install once, then run forge against your project. The walkthrough uses a generic `~/code/my-app` to make it concrete; replace with whichever project you actually want to work on.

## 1. Install (once per machine)

```bash
cd ~/code/forge
npm install
npm link                    # puts `forge` on $PATH
./scripts/install-seeds.sh
./docker/build.sh           # one-time, ~5–10 min
```

`install-seeds.sh` copies the default agent role directories, constraints, runtimes, and workflow YAML into `~/.forge/`. `docker/build.sh` builds the `agent-dev-worker` image (Ubuntu 22.04 + Node 20 + Claude Code CLI + git/jq/playwright + agent UID 1000). `npm link` symlinks `./bin/forge` into a directory on your `$PATH` (typically `/usr/local/bin`), so `forge <cmd>` works from any cwd.

Verify: `which forge` should print a path; `forge --help` should list the commands.

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

`--aws-profile` sets which AWS profile to use. When bedrock is active, the profile is resolved in this order: `--aws-profile` flag → `.forge/project.json` `awsProfile` field → `AWS_PROFILE` env var → `"default"`. The resolved profile appears in the launch banner (e.g. `bedrock:adx-dev`). Before launching, forge runs a stale-STS pre-flight and exits with an error if the STS cache predates the current SSO session; the SSO watchdog starts automatically to keep the token fresh.

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

From your project directory:

```bash
cd ~/code/my-app
forge new feature "add login" \
  --brief "wire OAuth into the existing user table; reuse the session middleware"
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

When new forge commits arrive (new agents, workflows, CLI behavior), run `forge upgrade` from any project to refresh everything in one step:

```bash
cd ~/code/my-app
forge upgrade                  # pulls forge, npm install, refreshes ~/.forge/, re-inits project; runs release check
forge upgrade --rebuild-image  # also rebuilds the agent Docker image (run when the Dockerfile changed)
forge upgrade --dry-run        # see what would change without doing it
```

After the upgrade steps complete, `forge upgrade` automatically runs a read-only release check — image, runtime CLIs, auth credentials, policies, and seed drift — and surfaces any problems before the next dispatch. Run `forge doctor` for the full report, or `forge setup` on a new machine to create the active model policy from the seed at the same time.

New machine? See `docs/work-laptop-setup.md` for the full setup checklist.

Full doc: `docs/how-to-upgrade.md` (flags, multi-project loop, manual recipe).

## 12. Dashboard (optional)

The web view ships as an npm workspace in the forge repo (`dashboard/`). One install from step 1 covered both forge and the dashboard; no separate setup.

```bash
forge dashboard start              # boots http://127.0.0.1:8024
forge dashboard start --port 8025  # custom port
```

Reads `~/.forge/forge.db` directly (read-only — won't contend with `forge next`). Renders agent results as markdown cards by agent type (architect risks, tech-lead plans, engineer diffs, red verdicts). Always cross-project: the dashboard intentionally shows runs across every project on the host (the cross-project survey surface), independent of `forge status`'s workspace filter. Schema contract: `docs/SCHEMA-CONTRACT.md`.
