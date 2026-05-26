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
. ~/code/forge/scripts/use-bedrock.sh       # arms AWS_PROFILE + CLAUDE_CODE_USE_BEDROCK=1 + the SSO watchdog
```

Sourcing (not running) the script is required so the env vars stay set in your shell. The script does NOT snapshot STS env vars — agent containers read SSO state directly from a mounted `~/.aws` and a host-side watchdog (`scripts/run-sso-watchdog.sh`) keeps the SSO cache fresh in the background. See FORGE-DEC-013 for why.

For multi-hour runs the watchdog refreshes silently every 5 minutes via the SSO refresh token — no browser pop unless your refresh token (typically days/weeks) has also expired. The watchdog auto-starts when forge dispatches a run and auto-stops when the run completes; PID is tracked at `~/.forge/sso-watchdog.pid`.

### API key (escape hatch)

```bash
export ANTHROPIC_API_KEY=sk-...
```

## 3. Set up your project (once per project)

```bash
cd ~/code/my-app
forge init
```

This installs the forge orchestrator block into `~/code/my-app/CLAUDE.md` (creating the file if needed), creates a `~/code/my-app/.forge/` directory for project-level workflow overrides, AND installs two kinds of hooks:

- A `commit-msg` git hook that rejects commits with `Co-Authored-By: Claude` trailers or other AI-attribution boilerplate (defense-in-depth for the `no-ai-attribution` constraint).
- Claude Code session lifecycle hooks (SessionStart / Stop / SessionEnd) wired into `.claude/settings.local.json` (per-developer, gitignored) that write a heartbeat file at `~/.forge/orchestrators/<session-id>.json`. `forge projects list` reads these to show which orchestrators are currently live (●), and the dashboard surfaces the same signal in its Projects view.
- Slash commands `/orient` and `/handoff` symlinked into `.claude/commands/` (per-developer, gitignored). `/orient` runs the start-of-session protocol (notes / active tickets / git state / live sessions) and ends with "What's the priority?" `/handoff` drafts the next-session notes block and applies it via `forge backlog notes replace`. Both hard-code use of the `forge backlog` CLI instead of reading the file whole. See `docs/concepts.md → Slash commands`.
- Entries in `.gitignore` for the two per-developer paths above so they don't get accidentally committed.

**Convention:** `.claude/settings.local.json` and `.claude/commands/` are per-developer (machine-local), because they hold machine-absolute paths into this developer's forge clone. The project's `.claude/settings.json` (if present) stays untouched by forge — it remains available for project-shared config like permissions. New contributors run `forge init` once after cloning, exactly like `npm install` reconstructing `node_modules/`.

Re-run `forge init` any time you upgrade forge — the orchestrator block is fence-marked and replaces in place; the commit-msg hook is a symlink; the Claude hooks are merged into `.claude/settings.local.json` (existing user hooks are preserved, only the forge heartbeat entries get upgraded); slash commands are symlinks so template edits in the forge repo flow to every project on next session; `.gitignore` gets the per-developer entries appended if missing. All re-runs are idempotent. `forge upgrade` performs the same re-init across the current project as step 4, so already-init'd projects pick up new hooks / commands automatically — including auto-migration of projects whose hooks landed in the committed `.claude/settings.json` before this convention shipped.

Skip all four installs with `forge init --no-install-hooks` if you'd rather wire them yourself. Forge never clobbers an existing `commit-msg` hook, an unrelated key in `.claude/settings.local.json`, a project-local `.claude/commands/<name>.md` override (regular file, not a forge symlink), or your `.gitignore`'s existing entries; if `settings.local.json` is unparseable JSON it's left alone with a SKIPPED notice.

## 4. Pick a path: orchestrator-led or direct CLI

After `forge init`, you have two ways to drive forge in this project. They're equally valid and use the same underlying runs/tasks/gates — the difference is who decides which agent to call.

**Orchestrator-led (the conversational path).** Start `claude` in `~/code/my-app`. The orchestrator block in `CLAUDE.md` makes that session the project's forge orchestrator. You say *"add OAuth login using the existing user table"*, the orchestrator classifies the request (implementation work), picks the right workflow (`feature`), constructs the brief, calls `forge new feature` for you, watches the run, presents each gate with a recommendation, and reports the final result. You never type a `forge` command yourself. This is the recommended path for ad-hoc work.

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

`forge new` records the current directory as the run's `projectDir`. Agent containers will mount it at `/project` (read-write for implementers, read-only for reds). You can override with `--project <dir>` if you want to drive a run for a different repo from your current cwd.

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

Shows the architecture-advisor's risks and constraints. If looks good:

```bash
forge gate task-architect-f68eb8 advance
```

Forge creates the `plan` task under the next phase.

## 8. Continue

```bash
forge next run-add-login-7c2a91
```

The pipeline runs phase-by-phase: architect → tech-lead (plan) → engineer (build, with reds in parallel) → qa-engineer (verify). Gate each step with `advance`, `reject`, or `request-changes --rationale "..."`. The run can't move to the next phase until every sibling is gated.

## 9. End of run

After `verify` completes (auto-gate), the run is marked `complete`.

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
forge upgrade           # pulls forge, runs npm install, refreshes ~/.forge/, re-inits this project's CLAUDE.md
forge upgrade --dry-run # see what would change without doing it
```

Full doc: `docs/how-to-upgrade.md` (flags, multi-project loop, manual recipe).

## 12. Dashboard (optional)

The web view ships as an npm workspace in the forge repo (`dashboard/`). One install from step 1 covered both forge and the dashboard; no separate setup.

```bash
forge dashboard start              # boots http://127.0.0.1:8024
forge dashboard start --port 8025  # custom port
```

Reads `~/.forge/forge.db` directly (read-only — won't contend with `forge next`). Renders agent results as markdown cards by agent type (architect risks, tech-lead plans, engineer diffs, red verdicts). Always cross-project: the dashboard intentionally shows runs across every project on the host (the cross-project survey surface), independent of `forge status`'s workspace filter. Schema contract: `docs/SCHEMA-CONTRACT.md`.
