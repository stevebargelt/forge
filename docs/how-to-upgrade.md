# Upgrading forge

When forge has new agent seeds, new workflow YAML, new CLI behavior, or new deps, every project on the host needs to pick up the changes. The `forge upgrade` command does the dance.

What it will actually do depends on **which forge you ran**: the stable machine-wide `forge` (a promoted release) refreshes host and project assets from its own bundled bytes but refuses to touch your git checkout, while `forge-dev` does both. If you only read one section, read [Execution mode](#execution-mode-what-upgrade-will-and-wont-do).

## The fast path

From the project you're currently working in:

```bash
cd ~/code/my-app
forge upgrade
```

This runs four steps in sequence:

1. **`git pull --ff-only`** in the dev checkout (`~/code/forge` by default; override via `--forge-repo` or `FORGE_REPO_DIR`). Refuses if the working tree is dirty — protects in-progress forge changes. **Refused under a promoted release** — see [Execution mode](#execution-mode-what-upgrade-will-and-wont-do) below.
2. **`npm install`** in the dev checkout. Picks up new top-level deps and new workspace deps (e.g. the `dashboard/` workspace's `marked` after #140). **Refused under a promoted release.**
3. **`FORCE=1 ./scripts/install-seeds.sh`**, run from the forge that is executing to refresh `~/.forge/agents/`, `constraints/`, `workflows/`, `runtimes/`, and `forge-raci.md` from the new seeds, plus the `forge-*` workflow skills in `~/.claude/skills/` (user-global, not `~/.forge/`) — then **recompile the derived `~/.forge/routing-policy.yml`** from the refreshed RACI. The routing policy is generated, never hand-maintained, so upgrade regenerates it in lockstep; you never run `forge route compile` by hand after an upgrade. A compile failure is reported loudly with the exact reason (the rest of the upgrade still runs).
4. **Provision the current project** (when the cwd's `CLAUDE.md` looks like a forge project — a fence marker *or* a `# forge orchestrator` heading). This **always** installs/refreshes the per-machine pieces — slash commands (`/orient`, `/handoff`), Claude session hooks, `.gitignore` entries — because those are machine-local and not committed, so every new machine needs them even when `CLAUDE.md` is committed. It then refreshes the orchestrator **block**: replaced in place when fenced (head/tail preserved); **repaired** when only the end marker is present (start re-inserted before the heading); and for an unfenced legacy block or a lone start marker it leaves the block untouched and prints exactly which markers to add (the end can't be inferred without risking your project-specific tail). `forge init` is for genuinely new projects; `forge upgrade` is the path for existing ones (#231).

Output is compact — one line per step plus any orphan-warnings from the seeds install. After the steps complete, a read-only release check runs automatically — it verifies the agent image, in-image runtime CLIs, auth credentials, policies, and seed drift (installed `~/.forge` seeds vs the running code), surfacing any problems before the next dispatch. Run `forge doctor` for the full report.

> `forge upgrade` does **not** rebuild the agent Docker image or run provider login by default. To rebuild after changing any of the image's **build inputs** — the Dockerfile *or* any file it `COPY`s (today `docker/forge-test.sh` and `docker/agent-entrypoint.sh`) — add `--rebuild-image` **from a dev checkout**; it is refused under a release. Auth credentials (`codex login` / `forge auth login`) are per-machine; run `forge doctor` after upgrade to verify auth and policy readiness (#229).

## Execution mode: what upgrade will and won't do

`forge upgrade` has **two halves**, and which of them run depends on what the `forge` you typed actually is (FG-577):

- **Asset installation** (steps 3 and 4 — host seeds, the `forge-*` skills, the routing-policy recompile, the project's orchestrator template) always installs the bytes of **the forge that is executing**, resolved relative to its own module. Under `forge-dev` or an npm-linked checkout that's your working tree; under a promoted release it is the **release's own** bundled `seeds/` and `scripts/install-seeds.sh`. It reads `~/code/forge` in neither case.
- **Dev-checkout advancement** (steps 1 and 2, plus `--rebuild-image`) mutates a git checkout. Under a promoted release it is **refused**, by name, and `~/code/forge` is left untouched. A release carries no git history to pull into, and advancing the checkout would mutate a tree the running process isn't executing from.

The upgrade header names both roots and which mode it decided, so you never have to guess:

```
forge upgrade
  Assets:        /Users/you/forge-releases/r1 (executing release)
  Dev checkout:  /Users/you/code/forge (not advanced — see below)
  Project (cwd): /Users/you/code/my-app
```

Under `forge-dev` the same header reads `Assets: /Users/you/code/forge (dev checkout, npm-linked)` and the dev checkout is advanced normally.

A refusal is not a silent skip. Steps 1 and 2 print `REFUSED`, upgrade explains why and points at the checkout-side command, and — because a requested action that didn't happen is a failed request — `forge upgrade` **exits nonzero** and closes with `Upgrade INCOMPLETE — dev advancement refused (release).` rather than `Upgrade complete.` The same is true of a failed `install-seeds.sh` or a refused `--rebuild-image`.

Two consequences worth internalizing, because they change how you script this:

- **Every** release-mode `forge upgrade` reports `INCOMPLETE` and exits 1, including `forge upgrade --skip-git --skip-npm`. The refusal is decided by execution mode before the skip flags are read, so `--skip-git` does not turn it into a clean run. The asset half still succeeds — the nonzero exit says "not everything you asked for happened," not "nothing worked." If you want a release host to refresh `~/.forge/` with a zero exit, there is no flag for it today; either accept the exit code or drive the checkout with `forge-dev`.
- A `--dry-run` mutates nothing and is a report rather than a request, so it stays exit 0 in either mode.

To advance the checkout, drive it from the checkout:

```bash
forge-dev upgrade --skip-project      # or: cd ~/code/forge && git pull && npm install
```

**Asset repair needs no dev checkout at all.** This is deliberate: `~/.forge` being broken or drifted is exactly when you need `forge upgrade`, so a release repairs host seeds from its own bundled assets even on a machine that has never cloned forge. A refusal never blocks that half — steps 3 and 4 run in the same command that refused steps 1 and 2. If the checkout is simply absent in dev mode, steps 1 and 2 report `SKIPPED` (nothing was refused and nothing failed, so the exit code stays 0).

> **`--forge-repo` and `FORGE_REPO_DIR` mean exactly one thing: the checkout that dev-advancement operates on.** They are never an asset source and never redirect what gets installed into `~/.forge/` — pointing them at another tree cannot make a release install that tree's bytes. They also no longer influence seed-drift detection, whose baseline is a release-owned asset.

## Useful flags

```
forge upgrade --dry-run         # show what would change, no writes
forge upgrade --skip-git        # local-only changes; don't pull
forge upgrade --skip-npm        # deps haven't changed; faster loop
forge upgrade --skip-project    # don't touch this project's CLAUDE.md
forge upgrade --forge-repo <dir># the dev checkout to advance lives somewhere other than ~/code/forge
forge upgrade --rebuild-image   # also rebuild the agent Docker image (runs docker/build.sh); dev-checkout only
```

`--dry-run` is the right thing to try first if you're unsure what an upgrade will do — it prints the four-step plan with what each would do, then exits.

`--skip-git` / `--skip-npm` / `--forge-repo` / `--rebuild-image` all address the dev-advancement half only. Under a release, advancement is refused whether or not you pass them.

## Updating multiple projects

`forge upgrade` only re-inits the **current** project's CLAUDE.md. If you have several projects with orchestrator blocks (e.g. `~/code/my-app`, `~/code/audit-workspace`, `~/code/forge` itself), pick the right loop:

```bash
# Approach A: upgrade once globally, then re-init each project's CLAUDE.md.
forge upgrade --skip-project                      # global refresh, leave project blocks alone
                                                  # (from a release this refreshes ~/.forge/ from the
                                                  #  release and refuses the pull — see Execution mode)
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

- **After pulling new forge commits.** The `git pull` step is the trigger. From a dev checkout; a release has nothing to pull.
- **After editing local forge source.** Run `forge-dev upgrade --skip-git` so the existing dirty tree doesn't block the rest of the flow; seeds still get refreshed and the project block re-inits against your local changes. Use `forge-dev`, not `forge`: the stable `forge` installs the promoted release's seeds, not your edits.
- **When a seed change won't take effect.** The orchestrator template, agent CLAUDE.mds, and workflow YAMLs all live in `~/.forge/` after install. Editing `seeds/*` in the forge source doesn't update `~/.forge/*` until `install-seeds.sh` runs — and only the forge you actually run installs its own copy, so `forge-dev upgrade --skip-git --skip-npm` is the shortest way to get *your edits* into `~/.forge/`.
- **When `~/.forge/` is drifted or broken.** `forge upgrade` is the named remedy for the seed-drift the release check reports, and it works from a release with no dev checkout on the host — the assets come from the release itself.

## When NOT to use `forge upgrade`

- **You only want to test a single local seed change.** Faster: `FORCE=1 ./scripts/install-seeds.sh` (in the forge repo) and skip the CLI overhead.
- **You want to advance the checkout and only the stable `forge` is on your `$PATH`.** It will refuse. Use `forge-dev upgrade` from the checkout instead.
- **You're on a release *branch* of forge and want to stay there.** `forge upgrade` runs `git pull --ff-only` against the configured upstream. If your local branch isn't tracking the right remote branch (or you're intentionally on a stale commit), pass `--skip-git`. (This is a git branch, not a promoted release — the pull only happens in dev mode either way.)
- **The forge repo's working tree is dirty AND you don't want to lose those changes.** Step 1 refuses cleanly in this case; you'll see "SKIPPED (working tree has uncommitted changes)" and the rest of the upgrade still runs. But the seeds you install will be from your in-progress source, not from upstream. Usually fine, sometimes not.

## Manual recipe (from-scratch upgrade without the command)

If `forge upgrade` itself broke, or you want to do it by hand. This is the **dev-checkout** flow — it is also what you run by hand when a release refused the advancement half:

```bash
cd ~/code/forge
git pull --ff-only
npm install
FORCE=1 ./scripts/install-seeds.sh
bash docker/build.sh                # rebuild the agent image (only if a build input changed:
                                    # the Dockerfile or a script it COPYs)
cd ~/code/<your-project>
forge init                          # only if this project has the orchestrator block
forge doctor                        # release check: image, runtime CLIs, auth, policies, seed drift
```

This mirrors `forge-dev upgrade` step-for-step, plus the two things the command makes optional/automatic: the image rebuild (`forge-dev upgrade --rebuild-image`) and the release check that runs automatically at the end of every upgrade (here run by hand as `forge doctor`). Knowing the manual flow makes the CLI command unnecessary if you ever need to debug something — and it is exactly the flow a release refuses to run for you.

## What the upgrade does NOT do

- **Does not rebuild the agent Docker image by default.** If any of the image's build inputs changed, pass `--rebuild-image` to handle it in the same command (`forge-dev upgrade --rebuild-image`), or run `./docker/build.sh` separately. Both are dev-checkout operations: rebuilding runs a script from, and bakes an image out of, the checkout, so **a release refuses `--rebuild-image`** rather than build from a tree it isn't executing from. A build input is `docker/agent-dev-worker.Dockerfile` **or any file the Dockerfile `COPY`s** — currently `docker/forge-test.sh` (the in-image test wrapper) and `docker/agent-entrypoint.sh`. Editing one of those scripts leaves the built image stale even though the Dockerfile's own mtime never moved, which is exactly the case that used to slip through. Forge will keep using the old image until you rebuild — usually fine, but watch for breakage if the image picked up something load-bearing (e.g. a new tool in PATH, or a changed test-wrapper exit contract).
- **Does not judge image staleness from a release.** In **dev** mode, `forge doctor` (and the release check at the end of `forge upgrade`) compares the image's build timestamp against the newest of all build inputs and reports `STALE` when it's behind. Under a **release** that comparison is suppressed and the check reports presence only: a release tree is materialized by copy, which does not preserve timestamps, so every bundled build input is stamped at release-build time and would read as newer than any image — reporting every release host permanently `STALE`, and naming a rebuild that refuses there. Rebuild advice is mode-aware and points a release host at `forge-dev upgrade --rebuild-image`. (The heuristic's wider false-positive class is FG-543.)
- **Does not touch the SQLite DB.** Schema migrations (rare) happen at next forge invocation when the DB opens. No upgrade-time action needed.
- **Does not refresh other projects' CLAUDE.md.** Only the cwd's, and only if the block exists. See "Updating multiple projects" above.
- **Does not restart any running orchestrator sessions.** If a Claude Code session has the orchestrator block loaded, it stays on the old template until restart. Restart the session to pick up new orchestrator behavior.
