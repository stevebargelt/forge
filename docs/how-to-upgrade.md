# Upgrading forge

When the forge repo has new commits — new agent seeds, new workflow YAML, new CLI behavior, new deps — every project on the host needs to pick up the changes. The `forge upgrade` command does the dance.

## The fast path

From the project you're currently working in:

```bash
cd ~/code/my-app
forge upgrade
```

This runs four steps in sequence:

1. **`git pull --ff-only`** in the forge repo (`~/code/forge` by default; override via `--forge-repo` or `FORGE_REPO_DIR`). Refuses if the working tree is dirty — protects in-progress forge changes.
2. **`npm install`** in the forge repo. Picks up new top-level deps and new workspace deps (e.g. the `dashboard/` workspace's `marked` after #140).
3. **`FORCE=1 ./scripts/install-seeds.sh`** to refresh `~/.forge/agents/`, `constraints/`, `workflows/`, `runtimes/`, and `forge-raci.md` from the new seeds, plus the `forge-*` workflow skills in `~/.claude/skills/` (user-global, not `~/.forge/`) — then **recompile the derived `~/.forge/routing-policy.yml`** from the refreshed RACI. The routing policy is generated, never hand-maintained, so upgrade regenerates it in lockstep; you never run `forge route compile` by hand after an upgrade. A compile failure is reported loudly with the exact reason (the rest of the upgrade still runs).
4. **Provision the current project** (when the cwd's `CLAUDE.md` looks like a forge project — a fence marker *or* a `# forge orchestrator` heading). This **always** installs/refreshes the per-machine pieces — slash commands (`/orient`, `/handoff`), Claude session hooks, `.gitignore` entries — because those are machine-local and not committed, so every new machine needs them even when `CLAUDE.md` is committed. It then refreshes the orchestrator **block**: replaced in place when fenced (head/tail preserved); **repaired** when only the end marker is present (start re-inserted before the heading); and for an unfenced legacy block or a lone start marker it leaves the block untouched and prints exactly which markers to add (the end can't be inferred without risking your project-specific tail). `forge init` is for genuinely new projects; `forge upgrade` is the path for existing ones (#231).

Output is compact — one line per step plus any orphan-warnings from the seeds install. After the steps complete, a read-only release check runs automatically — it verifies the agent image, in-image runtime CLIs, auth credentials, policies, and seed drift (installed `~/.forge` seeds vs the running code), surfacing any problems before the next dispatch. Run `forge doctor` for the full report.

> `forge upgrade` does **not** rebuild the agent Docker image or run provider login by default. To rebuild after pulling Dockerfile changes (e.g. a new Codex CLI), add `--rebuild-image`. Auth credentials (`codex login` / `forge auth login`) are per-machine; run `forge doctor` after upgrade to verify auth and policy readiness (#229).

## Useful flags

```
forge upgrade --dry-run         # show what would change, no writes
forge upgrade --skip-git        # local-only changes; don't pull
forge upgrade --skip-npm        # deps haven't changed; faster loop
forge upgrade --skip-project    # don't touch this project's CLAUDE.md
forge upgrade --forge-repo <dir># forge source is somewhere other than ~/code/forge
forge upgrade --rebuild-image   # also rebuild the agent Docker image (runs docker/build.sh)
```

`--dry-run` is the right thing to try first if you're unsure what an upgrade will do — it prints the four-step plan with what each would do, then exits.

## Updating multiple projects

`forge upgrade` only re-inits the **current** project's CLAUDE.md. If you have several projects with orchestrator blocks (e.g. `~/code/my-app`, `~/code/audit-workspace`, `~/code/forge` itself), pick the right loop:

```bash
# Approach A: upgrade once globally, then re-init each project's CLAUDE.md.
cd ~/code/forge && forge upgrade --skip-project   # global refresh, leave project blocks alone
for p in ~/code/my-app ~/code/audit-workspace; do
  cd "$p" && forge init
done

# Approach B: run forge upgrade from each project (does the global refresh on
# every iteration — wasteful but conceptually simpler).
for p in ~/code/my-app ~/code/audit-workspace; do
  cd "$p" && forge upgrade --skip-git --skip-npm
done
# (run forge upgrade once without --skip flags first to do the actual pull + install)
```

Most users only have one or two projects that need the block refreshed; manual `forge init` per project is fine.

## When to upgrade

- **After pulling new forge commits.** The `git pull` step is the trigger.
- **After editing local forge source.** Pass `--skip-git` so the existing dirty tree doesn't block the rest of the flow; seeds still get refreshed and the project block re-inits against your local changes.
- **When a seed change won't take effect.** The orchestrator template, agent CLAUDE.mds, and workflow YAMLs all live in `~/.forge/` after install. Editing `seeds/*` in the forge source doesn't update `~/.forge/*` until `install-seeds.sh` runs. `forge upgrade --skip-git --skip-npm` is the shortest way to refresh just those.

## When NOT to use `forge upgrade`

- **You only want to test a single local seed change.** Faster: `FORCE=1 ./scripts/install-seeds.sh` (in the forge repo) and skip the CLI overhead.
- **You're on a release branch of forge and want to stay there.** `forge upgrade` runs `git pull --ff-only` against the configured upstream. If your local branch isn't tracking the right remote branch (or you're intentionally on a stale commit), pass `--skip-git`.
- **The forge repo's working tree is dirty AND you don't want to lose those changes.** Step 1 refuses cleanly in this case; you'll see "SKIPPED (working tree has uncommitted changes)" and the rest of the upgrade still runs. But the seeds you install will be from your in-progress source, not from upstream. Usually fine, sometimes not.

## Manual recipe (from-scratch upgrade without the command)

If `forge upgrade` itself broke, or you want to do it by hand:

```bash
cd ~/code/forge
git pull --ff-only
npm install
FORCE=1 ./scripts/install-seeds.sh
bash docker/build.sh                # rebuild the agent image (only if the Dockerfile changed)
cd ~/code/<your-project>
forge init                          # only if this project has the orchestrator block
forge doctor                        # release check: image, runtime CLIs, auth, policies, seed drift
```

This mirrors `forge upgrade` step-for-step, plus the two things the command makes optional/automatic: the image rebuild (`forge upgrade --rebuild-image`) and the release check that runs automatically at the end of `forge upgrade` (here run by hand as `forge doctor`). Knowing the manual flow makes the CLI command unnecessary if you ever need to debug something.

## What the upgrade does NOT do

- **Does not rebuild the agent Docker image by default.** If `docker/agent-dev-worker.Dockerfile` changed, pass `--rebuild-image` to handle it in the same command (`forge upgrade --rebuild-image`), or run `./docker/build.sh` separately. Forge will keep using the old image until you rebuild — usually fine, but watch for breakage if the image picked up something load-bearing (e.g. a new tool in PATH).
- **Does not touch the SQLite DB.** Schema migrations (rare) happen at next forge invocation when the DB opens. No upgrade-time action needed.
- **Does not refresh other projects' CLAUDE.md.** Only the cwd's, and only if the block exists. See "Updating multiple projects" above.
- **Does not restart any running orchestrator sessions.** If a Claude Code session has the orchestrator block loaded, it stays on the old template until restart. Restart the session to pick up new orchestrator behavior.
