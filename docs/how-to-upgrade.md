# Upgrading forge

When forge has new agent seeds, new workflow YAML, new CLI behavior, or new deps, every project on the host needs to pick up the changes. The `forge upgrade` command does the dance.

What it will actually do depends on **which forge you ran**: the stable machine-wide `forge` (a promoted release) refreshes host and project assets from its own bundled bytes but refuses to touch your git checkout, while `forge-dev` does both. If you only read one section, read [Execution mode](#execution-mode-what-upgrade-will-and-wont-do).

## The fast path

From the project you're currently working in:

```bash
cd ~/code/my-app
forge upgrade
```

This runs five steps in sequence:

1. **`git pull --ff-only`** in the dev checkout (`~/code/forge` by default; override via `--forge-repo` or `FORGE_REPO_DIR`). Does not pull if the working tree is dirty — protects in-progress forge changes, and exits 1, because you asked for advancement and did not get it. **Refused under a promoted release** — see [Execution mode](#execution-mode-what-upgrade-will-and-wont-do) below.
2. **`npm install`** in the dev checkout. Picks up new top-level deps and new workspace deps (e.g. the `dashboard/` workspace's `marked` after #140). **Refused under a promoted release.**
3. **`FORCE=1 ./scripts/install-seeds.sh`**, run from the forge that is executing. It refreshes the **forge-owned** seeds — `~/.forge/workflows/` and `runtimes/` — plus the `forge-*` workflow skills in `~/.claude/skills/` (user-global, not `~/.forge/`). The **operator-authored** seeds — `~/.forge/agents/`, `constraints/`, and `forge-raci.md` — are **create-only**: installed when absent, **retained** when present, even under `FORCE=1` (FG-578). The installer seeds them once and never writes over them again, so a gated `forge raci apply` change or a local edit to an agent/constraint prompt survives every upgrade; when a retained file differs from this release's seed, upgrade prints a ⚠ naming it as *not refreshed* (see the output note below) — it is out of forge's control path and yours to merge. **One part of an agent seed is no longer yours, and step 4 below is what maintains it**: the marker-fenced Forge-owned protocol region (FG-654). This step's behavior is unchanged — the installer still writes no agent seed that already exists — but on an existing host it no longer leaves you with a dispatchable set of agent seeds by itself. Upgrade then **recompiles the derived `~/.forge/routing-policy.yml`** from the host RACI, whether that RACI was freshly created or retained. The routing policy is generated, never hand-maintained, so upgrade regenerates it in lockstep; you never run `forge route compile` by hand after an upgrade. A compile failure is reported loudly with the exact reason (the specific rejected RACI construct) and the rest of the upgrade still runs, but the promoted runtime will **not** let the previous runtime's compiled `routing-policy.yml` stay silently authoritative when it can no longer vouch for the RACI that policy derives from: it **invalidates** the stale policy in place — quarantining it to `routing-policy.yml.quarantined` (or, if that rename can't happen, removing it; and if neither can, saying so loudly and telling you to remove it by hand). A missing host policy is itself fail-closed — routing falls back to lane `manual` / `policy_not_found` — so this leaves routing safe rather than running under a policy the new runtime rejects. The warning names the rejected construct and the repair (`fix $FORGE_HOME/forge-raci.md, then run: forge route compile` — the path follows `FORGE_HOME`, so under a non-default `FORGE_HOME` the refusal names the actual file there, not `~/.forge/`), and the run closes `INCOMPLETE` and exits 1. A host with no RACI at all is not a failure — there is no derived artifact to keep in lockstep. As the last part of this step, upgrade **publishes the forge-owned, dispatch-coupled surface — the workflow and runtime YAMLs plus that derived routing policy — as one atomic *seed generation*** (FG-583): a complete generation is staged and committed with a single `rename(2)` over a dedicated seed pointer, sourced strictly from the executing release's own bundled `seeds/`. **This published generation is what dispatch actually reads** (`forge next`, gate advances, campaign items), not the flat `~/.forge/workflows`/`runtimes`/`routing-policy.yml` the installer also writes — those flat copies are retained only for the seed-drift detector and `forge doctor`'s runtime-registry enumeration. A concurrent `forge next` therefore observes either the whole generation that was current before the upgrade or the whole one this upgrade publishes — never a torn or old/new-mixed set; a dispatch already running stays anchored to the generation it opened. If the publication fails or is interrupted, the prior generation is left intact and selectable, the failure is reported by name, and the run closes `INCOMPLETE` and exits 1 — a partial install is never reported healthy, and every dispatch entry refuses to run under an *incomplete* generation (naming the state and pointing at `forge upgrade`) rather than dispatching under a set no release shipped.
4. **Publish the Forge-owned agent protocol region** into `~/.forge/agents/<role>/CLAUDE.md`, for every role the review lifecycle dispatches (FG-654). This runs **after** step 3, on purpose: the installer has just created any seed that was missing, and this pass then makes the fenced region current in each one — including the ones the installer retained. Everything outside the fence is left byte-for-byte as you wrote it, a seed already current is reported `unchanged`, and a legacy seed with no markers is **adopted** rather than replaced. It is the only thing that maintains that region: `install-seeds.sh` does not, and a stale region is refused at dispatch (see [Agent seeds: yours, except the protocol region](#agent-seeds-yours-except-the-protocol-region)).
5. **Provision the current project** (when the cwd's `CLAUDE.md` looks like a forge project — a fence marker *or* a `# forge orchestrator` heading). This **always** installs/refreshes the per-machine pieces — slash commands (`/orient`, `/handoff`), Claude session hooks, `.gitignore` entries — because those are machine-local and not committed, so every new machine needs them even when `CLAUDE.md` is committed. It then refreshes the orchestrator **block**: replaced in place when fenced (head/tail preserved); **repaired** when only the end marker is present (start re-inserted before the heading); and for an unfenced legacy block or a lone start marker it leaves the block untouched and prints exactly which markers to add (the end can't be inferred without risking your project-specific tail). `forge init` is for genuinely new projects; `forge upgrade` is the path for existing ones (#231).

Output is compact — one line per step, plus any operator-authored seeds the install **retained** (a ⚠ block naming each file forge did *not* overwrite and did *not* count as refreshed — `agents/`, `constraints/`, or `forge-raci.md` whose copy diverges from this release's seed), step 4's tally of what it did to the Forge-owned protocol regions plus a named line for each seed it refused, wrote a `.forge-pre-fg654.bak` for, or found no fenced release seed to publish from, and any orphan-warnings from the seeds install. After the steps complete, a read-only release check runs automatically — it verifies the agent image, in-image runtime CLIs, auth credentials, policies, and seed drift (installed `~/.forge` seeds vs the running code), surfacing any problems before the next dispatch. Run `forge doctor` for the full report. `forge doctor` additionally names an **incomplete** seed generation — a seed pointer that resolves to a torn or mid-publish generation carrying no valid provenance manifest — as a repairable state (`Seed install: INCOMPLETE (repairable)`), prints the fix (`forge upgrade`, which republishes a complete atomic generation), surfaces it in `--json` as a `seedInstall` block, and exits non-zero. `forge doctor` likewise names a host that has **never published a generation** — the flat pre-migration layout, a fresh or not-yet-upgraded host — as `Seed install: NOT INSTALLED`: dispatch reads only a published generation and there is no flat-layout fallback, so the loader refuses to dispatch until one is published. Doctor prints the same `forge upgrade` fix, surfaces the `no-generation` state in the `--json` `seedInstall` block, and exits non-zero. Only a **complete published generation** is healthy — both a torn/mid-publish generation and a never-published one are readiness problems `forge upgrade` repairs. Since FG-654 the same check also reports a **stale Forge-owned agent protocol region** as a failure and exits non-zero for it, where all agent-seed drift used to be a warning — see [Agent seeds: yours, except the protocol region](#agent-seeds-yours-except-the-protocol-region).

The check is skipped in two cases, and says which: on a `--dry-run` (nothing was installed to check), and when `install-seeds.sh` did not install, because a verdict would then describe a `~/.forge` this upgrade never touched — a stale state presented as a fresh verdict is worse than no verdict. If the check itself crashes, that is a state nobody verified rather than a nicety that was skipped: it exits 1.

Every step's outcome — including whether it did what you asked — is available machine-readably via [`--json`](#--json-the-machine-readable-result).

> `forge upgrade` does **not** rebuild the agent Docker image or run provider login by default. To rebuild after changing any of the image's **build inputs** — the Dockerfile *or* any file it `COPY`s (today `docker/forge-test.sh`, `docker/agent-entrypoint.sh`, `docker/forge-backlog-reader.mjs` and `docker/forge-backlog-bin.sh`) — add `--rebuild-image` **from a dev checkout**; it is refused under a release. Auth credentials (`codex login` / `forge auth login`) are per-machine; run `forge doctor` after upgrade to verify auth and policy readiness (#229).

## Agent seeds: yours, except the protocol region

Your `~/.forge/agents/<role>/CLAUDE.md` files are still yours to edit and are still never overwritten — with one carve-out that arrived in FG-654. Each seed for a role the review lifecycle dispatches now carries a **marker-fenced Forge-owned protocol region**: the review protocol a dispatched agent's output is judged against. Forge owns what is inside the fence; you own every line outside it. Before the split they shared one file and one retain-or-overwrite decision, so retaining your edits also froze forge's protocol — reviewers on upgraded hosts went on running a review contract several releases old, and it showed up as reviewers producing the wrong shape of output rather than as a seed problem.

What you will actually see:

- **Upgrade has a new pass (step 4) that maintains that region**, and it runs right after `install-seeds.sh`. Your own prose survives, in your own order — the fence takes the place of the Forge sections it adopted, so what you wrote above them stays above it and what you wrote below stays below. What *does* move is anything of yours that sat **between** two Forge sections, at either heading depth — a `##` section of your own as much as a `###` nested under a Forge heading — because the region is one contiguous block and there is no longer a "between" to sit in; it comes out immediately after the closing fence (see the `###` bullet below). Two whitespace caveats on the adoption path, and only there: the file's line endings are normalized to LF, and a run of blank lines landing directly against the fence is collapsed to one. Re-running upgrade on a current host reports the region `unchanged` and writes nothing.
- **A `<file>.forge-pre-fg654.bak` may appear beside a published seed**, and upgrade names it in its output. It is the file exactly as it was before the write, and it is written on **every** path that discards bytes: adoption excising a legacy protocol section whose content differed, *and* a re-publish replacing an already-fenced region whose content differed. (That second case matters because the repair text below asks you to hand-wrap the markers, and hand-wrapping one line too many puts your own prose inside the fence.) A seed already current is reported `unchanged` and gets no `.bak`. Nothing else consumes it — keep it if you want to diff, delete it when you're satisfied.
- **Each seed is committed by a single `rename(2)`**, staged beside itself first — the same way the seed generation in step 3 is published. An interrupted upgrade leaves every seed either fully at the old shape or fully at the new one; there is no torn file for a concurrent `forge next` to read.
- **An ambiguous seed is refused, not guessed.** Two shapes reach this rung. The first is a marker set that is not exactly one start marker and one end marker after it — a lone marker, a second pair, or an end that precedes its start — where the region has no readable boundary. The second is two copies of a protocol heading, where forge cannot tell *which* occurrence it would be claiming. Upgrade leaves the file **untouched**, names it, and prints the exact repair. A seed carrying only *some* of the region's headings is **not** one of them: that is what every host seeded before this release actually has, because the region's sections landed over several releases and an agent seed is never rewritten after creation (FG-578). It is adopted like any other legacy seed — refusing it would leave the seed unfenced, upgrade exiting 1, and that role refused at every dispatch with nothing you could do about it. The cost of adopting is that a `##` section of yours that happens to share a Forge heading's name is adopted too; that is a lossy path, so the `.forge-pre-fg654.bak` below holds the file exactly as it was and upgrade names it. A **symbolic link** standing at any path this pass would write is refused the same way and for the same reason: publishing through it would write outside the seed tree. That is the seed and its `.bak`, and also the `.forge-publish-tmp` staging file beside each — a link at the staging path redirects the write just as effectively, since the `rename(2)` moves the link. The refusal names whichever path is linked, so expect to see the staging suffix in the message if that is the one.
- **Your own `###` subsections nested under a Forge `##` heading survive adoption**, in the live file — not only in the `.bak`. Adoption replaces the sections the region owns, and a subsection heading the region does not carry is yours. **Where it ends up** depends on where you wrote it, because the region is one contiguous fenced block: a subsection written at the *end* of the adopted span is already adjacent to the fence and does not move at all, while one written *between* two Forge sections cannot stay between them — it is re-emitted immediately after the closing fence, verbatim, keeping its order relative to the rest of your content. The same is true of a top-level `##` section of yours that you wrote between two Forge `##` sections: unless its heading collides with one the region owns (the case above), it is never excised — but it lands after the fence rather than where you left it. Relocation is the only thing upgrade does to your content, and it relocates by at most the length of the fenced region. If it matters that a rule of yours reads under a specific Forge heading, wrap the Forge sections in the markers yourself and keep your rule outside them.
- **`forge doctor`'s exit code now goes red for a stale Forge-owned region.** *This is a change*: before FG-654 all agent-seed drift was operator-authored drift, which doctor reports as a warning and exits 0 on. A host that was green may now exit non-zero on the first `forge doctor` after upgrading, and the fix is `forge upgrade`. Drift in *your* half of the same file is unchanged — still a warning, still exit 0. The two are reported separately, so you can tell which one you're looking at.
- **A review dispatched against a stale region is refused at dispatch, by name.** The refusal names the role, both content hashes, and `forge upgrade` as the remedy — it does not reach a container. A missing seed for one of those roles refuses the same way, instead of dispatching an agent with no role contract at all.
- **An operator lens acceptance cannot clear that refusal**, and this is deliberate. `forge review accept-lens` exists so you can knowingly accept a *narrower* review — a lens that did not run, named as missing evidence. A stale-protocol lens is a different fact: it produced output under a contract nobody had stated to it, so accepting it would be accepting a review whose reviewer was never told the rules its findings are judged by. Collapsing the two would re-open exactly the silent failure the fence closes. Run `forge upgrade` and re-dispatch the lens.

## Execution mode: what upgrade will and won't do

`forge upgrade` has **two halves**, and which of them run depends on what the `forge` you typed actually is (FG-577):

- **Asset installation** (steps 3 through 5 — host seeds, the `forge-*` skills, the routing-policy recompile, the agent protocol region, the project's orchestrator template) always installs the bytes of **the forge that is executing**, resolved relative to its own module. Under `forge-dev` or an npm-linked checkout that's your working tree; under a promoted release it is the **release's own** bundled `seeds/` and `scripts/install-seeds.sh`. It reads `~/code/forge` in neither case.
- **Dev-checkout advancement** (steps 1 and 2, plus `--rebuild-image`) mutates a git checkout. Under a promoted release each step you ask for is **refused**, by name, and `~/code/forge` is left untouched. A step you skipped is not a request, so it is not refused — see the recipe table below. A release carries no git history to pull into, and advancing the checkout would mutate a tree the running process isn't executing from.

The upgrade header names both roots and which mode it decided, so you never have to guess:

```
forge upgrade
  Assets:        /Users/you/forge-releases/r1 (executing release)
  Dev checkout:  /Users/you/code/forge (not advanced — see below)
  Project (cwd): /Users/you/code/my-app
```

Under `forge-dev` the same header reads `Assets: /Users/you/code/forge (dev checkout, npm-linked)` and the dev checkout is advanced normally.

A refusal is not a silent skip. Steps 1 and 2 print `REFUSED`, upgrade explains why and points at the checkout-side command, and — because a requested action that didn't happen is a failed request — `forge upgrade` **exits nonzero** and closes with `Upgrade INCOMPLETE — git pull refused (release); npm install refused (release).` rather than `Upgrade complete.`

**If you script against `forge upgrade`'s exit code, read this.** The nonzero exit is not limited to the release refusal. Every step reports a typed outcome, and *any* outcome that means "you asked for this and it did not happen" makes the whole run `INCOMPLETE` and exits 1. The full set:

| Step | Exits 1 when |
|---|---|
| `git pull` | refused (release); the dev checkout is dirty; the pull failed |
| `npm install` | refused (release); the install failed |
| `install-seeds.sh` | not found in the executing tree; the script failed |
| seed generation publication | the atomic publish failed or was interrupted (the prior generation stays intact and selectable) |
| agent protocol region | a seed's region could not be published — an ambiguous fence, a *duplicated* protocol heading or a symlinked seed upgrade refuses to guess at (the file is left untouched and the repair is printed; a seed carrying only some of the region's headings is adopted, not refused); the executing release carries no fenced seed for one of the covered roles, so nothing was published for it; or the write failed |
| routing-policy recompile | a host RACI exists and would not compile |
| project init | no `CLAUDE.md` here; `CLAUDE.md` has no forge block; the template is missing from the executing tree; the block needs manual markers |
| `--rebuild-image` | refused (release); the build failed |
| release check | it crashed |

Each of these previously exited 0 and printed `Upgrade complete.` while the requested action had not happened. If you have a script that treats exit 0 as "forge is current," it was reading a success that wasn't there in every row above.

What does **not** exit 1: anything nobody asked for. An operator skip (`--skip-git`, `--skip-npm`, `--skip-project`), a checkout that simply isn't on this host, no remote configured, no `package.json`, no host RACI, and a block that was already current are all **resolved** — they exit 0. An operator saying no is not a failed request.

A **project-local slash-command override** is on that list too, and deliberately so: if your project ships its own `.claude/commands/orient.md`, forge will not clobber a file it doesn't own, prints a ⚠ saying `/orient` was not installed, and exits 0. Your project owning that path is an answer, not a defect, and an exit code that fired forever on every project that gave one would be noise. It is still a *state* rather than a silence — `--json` reports it as `slashCommands: "user-override"` with the affected commands named in `slashCommandOverrides`, so a script sees exactly what the ⚠ said. To take forge's version, remove the file and re-run.

Two consequences worth internalizing, because they change how you script this:

- **A release-mode `forge upgrade` exits 1 only for the advancement you actually asked for.** The rule above is the whole rule — an operator skip outranks the mode refusal, because you cannot refuse what was never requested. So the release-host recipes come out like this:

  | On a release | git pull | npm install | Exit |
  |---|---|---|---|
  | `forge upgrade` | `REFUSED` | `REFUSED` | 1, `INCOMPLETE` |
  | `forge upgrade --skip-git` | `skipped (--skip-git)` | `REFUSED` | 1, `INCOMPLETE` |
  | `forge upgrade --skip-npm` | `REFUSED` | `skipped (--skip-npm)` | 1, `INCOMPLETE` |
  | `forge upgrade --skip-git --skip-npm` | `skipped (--skip-git)` | `skipped (--skip-npm)` | 0, `Upgrade complete.` |

  The two steps are classified independently, so `--skip-git` alone leaves your skip standing on step 1 while step 2 is still genuinely refused. **`forge upgrade --skip-git --skip-npm` is the way to refresh `~/.forge/` from a release host with a zero exit.** It exits 0 because nothing you asked for was refused — *not* because a release can advance a checkout. It still cannot: you asked for the asset half only, and the asset half is all that ran. Bare `forge upgrade` on a release still exits 1, and should: you asked for the full dance and half of it cannot happen. In every row the asset half succeeds — a nonzero exit says "not everything you asked for happened," not "nothing worked."
- **`--dry-run` can exit 1.** It mutates nothing, but it is a report an operator acts on, so its exit code and its `--json` `ok` agree with each other and are decided the same way as a real run: any state a dry run *can* observe without executing — the release refusal of `git pull`/`npm install`, a dirty checkout, a missing `install-seeds.sh`, a RACI that won't compile, a project with no forge block or no `CLAUDE.md` — makes the dry run exit 1 and print `Dry run: this upgrade would NOT complete — …`. (Two gaps worth knowing. A dry run reports `--rebuild-image` as `would-rebuild` without deciding it, so it does not predict the rebuild refusal a release-mode real run would raise. And step 4 always closes as `would-publish`, which is a resolved state: a seed needing a hand repair, or a covered role this release carries no fenced seed for, is fully *observed* by the dry run and **printed** in its step-4 lines, but does not make it exit 1 the way the same host's real run does. So read those lines rather than the exit code when you are dry-running to check the protocol region.) A dry run that finds nothing wrong says so without implying more than it checked, and closes with what it is structurally blind to:

  ```
  Dry run: nothing refused, and nothing decidable without executing is missing.
    NOT predicted: nothing was executed, so whether git pull, npm install, install-seeds.sh or an image rebuild would SUCCEED is unknown, and this host's release check was not run.
  Re-run without --dry-run to apply.
  ```

  A clean dry run is therefore **not** a forecast of a clean upgrade — it means "nothing I can decide without running is wrong."

To advance the checkout, drive it from the checkout:

```bash
forge-dev upgrade --skip-project      # or: cd ~/code/forge && git pull && npm install
```

**Asset repair needs no dev checkout at all.** This is deliberate: `~/.forge` being broken or drifted is exactly when you need `forge upgrade`, so a release repairs its **forge-owned** host seeds from its own bundled assets even on a machine that has never cloned forge. (Operator-authored seeds — `agents/`, `constraints/`, `forge-raci.md` — that have diverged are retained, not repaired; see [When to upgrade](#when-to-upgrade) and the `authoredRetention` field below. The Forge-owned protocol region inside an agent seed is the exception: it is repaired, and only from a release's own bundled seeds — see [Agent seeds: yours, except the protocol region](#agent-seeds-yours-except-the-protocol-region).) A refusal never blocks that half — steps 3 through 5 run in the same command that refused steps 1 and 2. To ask for that half and nothing else — the clean-exit release recipe — pass `forge upgrade --skip-git --skip-npm`. If the checkout is simply absent in dev mode, steps 1 and 2 report `SKIPPED` (nothing was refused and nothing failed, so the exit code stays 0).

> **`--forge-repo` and `FORGE_REPO_DIR` mean exactly one thing: the checkout that dev-advancement operates on.** They are never an asset source and never redirect what gets installed into `~/.forge/` — pointing them at another tree cannot make a release install that tree's bytes. They also no longer influence seed-drift detection, whose baseline is a release-owned asset.

## Useful flags

```
forge upgrade --dry-run         # show what would change, no writes
forge upgrade --skip-git        # local-only changes; don't pull
forge upgrade --skip-npm        # deps haven't changed; faster loop
forge upgrade --skip-project    # don't touch this project's CLAUDE.md
forge upgrade --forge-repo <dir># the dev checkout to advance lives somewhere other than ~/code/forge
forge upgrade --rebuild-image   # also rebuild the agent Docker image (runs docker/build.sh); dev-checkout only
forge upgrade --json            # emit the structured result instead of the human summary
```

`--dry-run` is the right thing to try first if you're unsure what an upgrade will do — it prints the five-step plan with what each would do, then exits. Note that it can exit 1, and that a clean dry run is not a promise of a clean upgrade — see [Execution mode](#execution-mode-what-upgrade-will-and-wont-do).

`--skip-git` / `--skip-npm` / `--forge-repo` / `--rebuild-image` all address the dev-advancement half only. Under a release, any advancement you still ask for is refused — but a skip is not a request, so `--skip-git --skip-npm` asks for no advancement at all and the run exits 0. See [Execution mode](#execution-mode-what-upgrade-will-and-wont-do).

## `--json`: the machine-readable result

`--json` suppresses the human rendering and prints a single JSON document to stdout. It is the same set of states the human output and the exit code are rendered from — `unresolved` is the one list all three surfaces derive from, so they cannot disagree about whether the upgrade did what was asked. A refusal a human can read but a script cannot is a refusal half the consumers miss.

```json
{
  "ok": false,
  "dryRun": false,
  "mode": "release",
  "assetsDir": "/Users/you/forge-releases/r1",
  "devDir": "/Users/you/code/forge",
  "devAdvancement": {
    "kind": "refused",
    "lines": ["forge upgrade: refusing to advance the dev checkout (git pull / npm install) — this forge is executing from a promoted release.", "..."],
    "gitPull": "refused",
    "npmInstall": "refused"
  },
  "assetInstall": "installed",
  "seedGeneration": "published",
  "seedGenerationError": null,
  "authoredRetention": "retained",
  "authoredRetentions": ["forge-raci.md"],
  "routingPolicy": "recompiled",
  "routingPolicyError": null,
  "projectInit": "refreshed",
  "slashCommands": "installed",
  "slashCommandOverrides": [],
  "imageRebuild": "skipped",
  "releaseCheck": "ran",
  "releaseProblems": [],
  "unresolved": ["git pull refused (release)", "npm install refused (release)"]
}
```

| Field | Type | Means |
|---|---|---|
| `ok` | boolean | `unresolved` is empty. Agrees with the exit code (`ok:false` ⇒ exit 1), **including on a dry run** |
| `dryRun` | boolean | `--dry-run` was passed; nothing was written |
| `mode` | `"release" \| "dev"` | Which forge is executing — decides whether advancement is refused |
| `assetsDir` | string | The executing tree every installed asset was read from |
| `devDir` | string | The checkout advancement targets. Never an asset source |
| `devAdvancement.kind` | `"proceed" \| "not-requested" \| "refused" \| "missing"` | `not-requested` = a release you asked for no advancement from (`--skip-git --skip-npm`); `missing` = no checkout on this host. Neither is unresolved |
| `devAdvancement.lines` | string[] | The refusal register — the same actionable lines the human surface prints. Empty unless `refused` or `missing` |
| `devAdvancement.gitPull` | `"pulled" \| "would-pull" \| "no-remote" \| "skipped" \| "unavailable" \| "refused" \| "dirty" \| "failed"` | Unresolved on `refused`, `dirty`, `failed` |
| `devAdvancement.npmInstall` | `"installed" \| "would-install" \| "no-package-json" \| "skipped" \| "unavailable" \| "refused" \| "failed"` | Unresolved on `refused`, `failed` |
| `assetInstall` | `"installed" \| "would-install" \| "not-found" \| "failed"` | Unresolved on `not-found`, `failed` |
| `seedGeneration` | `"published" \| "would-publish" \| "not-run" \| "failed"` | Unresolved on `failed`. The atomic publication of the dispatch-coupled generation (workflows + runtimes + derived routing policy). `not-run` = no release seeds to publish from (the asset install already reported that); `failed` = the publish failed or was interrupted and the prior generation is left intact — a partial install is never reported healthy |
| `seedGenerationError` | `string \| null` | The publication's verbatim failure reason on `failed` — the same named refusal the human warning prints; `null` on every non-`failed` path |
| `authoredRetention` | `"none" \| "retained" \| "not-run"` | Never unresolved. `retained` = forge left ≥1 operator-authored seed in place because your copy diverges from this release's seed; `none` = nothing to retain; `not-run` = the installer never ran, so nothing was inspected (not the same as `none`) |
| `authoredRetentions` | string[] | Which operator-authored seeds (`agents/`, `constraints/`, `forge-raci.md`) forge did NOT overwrite — paths relative to `~/.forge/`, the same set the human ⚠ names. Informational, never a failure; it is the only place a script learns those files are running unrefreshed. Empty unless `authoredRetention` is `retained`. Retention is about the operator's half of the file: an agent seed listed here still had its Forge-owned protocol region published by step 4 |
| `agentProtocol` | `"published" \| "already-current" \| "would-publish" \| "not-run" \| "needs-repair" \| "incomplete" \| "failed"` | Unresolved on `needs-repair`, `incomplete` and `failed`. Step 4, the Forge-owned protocol region inside each agent seed. `needs-repair` = at least one seed is yours to fix — an ambiguous marker fence, a duplicated protocol heading forge refused to guess at, or a symbolic link where the seed belongs — and those roles refuse at dispatch until you fix it. `incomplete` = the executing release carries no fenced seed for a covered role, so nothing was published for it; re-running here converges nothing (reinstall the release). `failed` = the publish threw (permissions, disk); roles published before it are current, the rest are not. `not-run` = the asset install never ran |
| `agentProtocolLines` | string[] | The publication report: a leading `agent protocol region: <n> adopted, <n> unchanged, …` tally by action, then one **named** line per seed that got a `.forge-pre-fg654.bak`, per seed left untouched pending a hand repair, and per covered role this release carries no fenced seed for. A role that was adopted, appended or replaced without a backup is counted in the tally but not named. The same lines the human surface prints |
| `agentProtocolError` | `string \| null` | The publish's verbatim I/O failure reason on `failed`; `null` on every other path, including `needs-repair` and `incomplete` — those are named states reported per role in `agentProtocolLines`, not errors |
| `routingPolicy` | `"recompiled" \| "would-recompile" \| "no-raci" \| "failed" \| "failed-not-neutralized"` | Unresolved on `failed` and `failed-not-neutralized`. `failed` = the promoted runtime rejected the host RACI, so the stale compiled policy was **invalidated** (quarantined to `routing-policy.yml.quarantined`, or removed) and routing is fail-closed until the RACI compiles — never left silently authoritative. `failed-not-neutralized` is the **exceptional** case: the RACI was rejected **and** neither the rename nor the fallback removal could take the stale policy off disk, so it is **still authoritative and routing is NOT fail-closed** — you must remove it by hand (`rm $FORGE_HOME/routing-policy.yml` — the refusal names the actual path under your `FORGE_HOME`, not `~/.forge/`) before routing fails closed. `no-raci` is fine — no derived artifact to keep in lockstep |
| `routingPolicyError` | `string \| null` | The compiler's verbatim reason for the rejected RACI construct — the same named refusal the human warning prints. `null` on every non-`failed`/non-`failed-not-neutralized` path. On `failed-not-neutralized` it also carries the neutralization failure (the policy is still authoritative; remove it by hand) |
| `projectInit` | `"refreshed" \| "already-current" \| "would-refresh" \| "skipped" \| "no-claude-md" \| "no-forge-block" \| "template-not-found" \| "needs-markers"` | Unresolved on the last four |
| `slashCommands` | `"installed" \| "already-current" \| "would-install" \| "user-override" \| "not-run"` | Never unresolved. `user-override` = this project already owns at least one of the command paths, so forge left it alone; `not-run` = project provisioning didn't reach this step (`--skip-project`, or no forge block) |
| `slashCommandOverrides` | string[] | Which commands were not installed and why — the same set the human ⚠ names. Empty unless `slashCommands` is `user-override` |
| `imageRebuild` | `"ran" \| "would-rebuild" \| "skipped" \| "refused" \| "failed"` | Unresolved on `refused`, `failed`. `skipped` when `--rebuild-image` wasn't passed |
| `releaseCheck` | `"ran" \| "skipped-dry-run" \| "skipped-asset-install" \| "failed"` | Unresolved only on `failed` |
| `releaseProblems` | `string[] \| null` | The release check's findings; `null` unless `releaseCheck` is `ran`. `[]` means it ran and found nothing |
| `unresolved` | string[] | Every requested action that did not happen, each with its reason. Empty ⇔ `ok:true` ⇔ exit 0 |

**Read `unresolved`, not the individual step fields.** It is derived from every step by one total classification, so it cannot omit a state that a step field reports. Checking `ok` tells you whether the upgrade did what was asked; reading `unresolved` tells you what didn't and why.

`releaseCheck` deserves one note: it is `skipped-asset-install` when `install-seeds.sh` didn't install, because its verdict would then describe a `~/.forge` this upgrade never refreshed — a stale state presented as a fresh verdict is worse than no verdict. That skip is not itself counted unresolved — the asset install already is, and the tail not running is the honest consequence rather than a second failure.

## Updating multiple projects

`forge upgrade` only re-inits the **current** project's CLAUDE.md. If you have several projects with orchestrator blocks (e.g. `~/code/my-app`, `~/code/audit-workspace`, `~/code/forge` itself), pick the right loop:

```bash
# Approach A: upgrade once globally, then re-init each project's CLAUDE.md.
forge upgrade --skip-git --skip-npm --skip-project   # global refresh, leave project blocks alone.
                                                     # Name both skips: from a release the pull AND the
                                                     # npm install are refused, so without them this
                                                     # exits 1 having still refreshed ~/.forge/.
                                                     # From a dev checkout, drop them to also advance it.
for p in ~/code/my-app ~/code/audit-workspace; do
  cd "$p" && forge init
done

# Approach B: run forge upgrade from each project (does the global refresh on
# every iteration — wasteful but conceptually simpler).
for p in ~/code/my-app ~/code/audit-workspace; do
  cd "$p" && forge upgrade --skip-git --skip-npm
done
# Advancing the checkout is separate work, and the stable `forge` refuses it. Do it
# once from the checkout BEFORE either loop, then build/promote to move `forge` onto
# the new commits:
#   cd ~/code/forge && ./bin/forge-dev upgrade --skip-project   # pull + npm install
```

Most users only have one or two projects that need the block refreshed; manual `forge init` per project is fine.

## When to upgrade

- **After pulling new forge commits.** The `git pull` step is the trigger. From a dev checkout; a release has nothing to pull.
- **After editing local forge source.** Run `forge-dev upgrade --skip-git` so the existing dirty tree doesn't block the rest of the flow; seeds still get refreshed and the project block re-inits against your local changes. Use `forge-dev`, not `forge`: the stable `forge` installs the promoted release's seeds, not your edits.
- **When a seed change won't take effect.** The orchestrator template and workflow/runtime YAMLs live in `~/.forge/` after install. Editing `seeds/*` in the forge source doesn't update `~/.forge/*` until an install runs — and only the forge you actually run installs its own copy, so `forge-dev upgrade --skip-git --skip-npm` is the shortest way to get *those* edits into `~/.forge/`. **For workflow and runtime edits, use `forge upgrade`, not `install-seeds.sh` alone** (FG-583): dispatch reads workflows, runtimes, and the derived routing policy from the atomically published *seed generation*, and only `forge upgrade` (dev or release) republishes that generation. `install-seeds.sh` on its own refreshes only the flat `~/.forge/workflows`/`runtimes` copies that the drift detector and `forge doctor`'s registry read — so a flat-only refresh will *not* change what a `forge next` actually runs once a generation has been published. **The agent prompts, constraints, and RACI are a further exception** (FG-578): once installed they are operator-owned, so upgrade retains them and a seed edit will *not* propagate — remove the file's `~/.forge/` copy first so the installer recreates it, or merge your change in by hand. **The exception has its own exception** (FG-654): an edit inside an agent seed's marker-fenced Forge-owned protocol region *does* propagate, because `forge upgrade` publishes that region — so `forge-dev upgrade --skip-git --skip-npm` is how you get a protocol-region edit onto the host, and everything outside the fence still needs the remove-or-merge above.
- **When `~/.forge/` is drifted or broken.** `forge upgrade` is the named remedy for the **forge-owned** seed-drift the release check reports, and it works from a release with no dev checkout on the host — the assets come from the release itself. On a release, ask for that half by name: `forge upgrade --skip-git --skip-npm` refreshes those seeds and exits 0. The authored agent, constraint, and RACI drift called out above is the exception: upgrade retains it, not remedies it — merge it in by hand, or remove the `~/.forge/` copy so the installer recreates it (FG-578). A **stale Forge-owned protocol region** inside an agent seed is not that kind of drift and is not yours to merge: `forge upgrade` is the remedy, it is what `forge doctor` will be failing on, and until it runs the affected roles refuse to dispatch (FG-654).

## When NOT to use `forge upgrade`

- **You only want to test a single local *forge-owned* seed change** (a workflow or runtime YAML). `FORCE=1 ./scripts/install-seeds.sh` (in the forge repo) refreshes the flat `~/.forge/` copies, but since FG-583 **that no longer changes what a dispatch runs** — `forge next`, gate advances, and campaigns read workflows and runtimes from the atomically published *seed generation*, and only `forge upgrade` republishes it. Use `forge-dev upgrade --skip-git --skip-npm` to publish a fresh generation from your local seeds (still faster than the full dance, and it is what dispatch will actually read). Note that any install **will not** push an edit to an already-installed operator-authored seed — `agents/`, `constraints/`, and `forge-raci.md` are create-only and retained when present (FG-578), so reinstalling over them is a no-op. To re-test an edit to one of those, remove its `~/.forge/` copy first so the installer recreates it, or copy the file in by hand. **Editing an agent seed's Forge-owned protocol region is the one case where `install-seeds.sh` alone is not merely slower but wrong** (FG-654): the installer does not touch that region at all, only `forge upgrade` publishes it, and on an existing host a region that was never published leaves the review lifecycle's roles refusing to dispatch. Run `forge-dev upgrade --skip-git --skip-npm`. **For `forge-raci.md` specifically**, the installer only writes the RACI — it does **not** recompile the derived routing policy, and since FG-583 a bare host `forge route compile` **no longer writes the flat file at all**: it validates that the host RACI compiles and directs you to `forge upgrade`, because the routing policy dispatch resolves lives *inside* the seed generation, compiled from the RACI at publish time (the flat `~/.forge/routing-policy.yml` is not a dispatch source). So after recreating or hand-copying the RACI, run a full `forge upgrade` (dev: `forge-dev upgrade --skip-git --skip-npm`) to republish the generation with the recompiled policy; otherwise the routing a dispatch resolves still reflects the *old* RACI you just replaced.
- **You want to advance the checkout and only the stable `forge` is on your `$PATH`.** It will refuse. Use `forge-dev upgrade` from the checkout instead.
- **You're on a release *branch* of forge and want to stay there.** `forge upgrade` runs `git pull --ff-only` against the configured upstream. If your local branch isn't tracking the right remote branch (or you're intentionally on a stale commit), pass `--skip-git`. (This is a git branch, not a promoted release — the pull only happens in dev mode either way.)
- **The forge repo's working tree is dirty AND you don't want to lose those changes.** Step 1 declines to pull in this case; you'll see `DID NOT RUN (working tree has uncommitted changes in forge repo)` and the rest of the upgrade still runs. A dirty tree is **not** an operator skip — you asked for advancement and did not get it — so the run closes `INCOMPLETE` and exits 1. Commit or stash in the checkout and re-run, or pass `--skip-git` to say you meant not to pull (which exits 0). Note the seeds you install will be from your in-progress source, not from upstream. Usually fine, sometimes not.

## Manual recipe (from-scratch upgrade without the command)

If `forge upgrade` itself broke, or you want to do it by hand. This is the **dev-checkout** flow — it is also what you run by hand when a release refused the advancement half:

```bash
cd ~/code/forge
git pull --ff-only
npm install
FORCE=1 ./scripts/install-seeds.sh  # refreshes forge-owned FLAT seeds; RETAINS your agents/constraints/RACI edits (FG-578)
# NOTE (FG-654): the cp above also does NOT publish the Forge-owned protocol region
# into ~/.forge/agents/<role>/CLAUDE.md — nothing but `forge upgrade` does. Skip the
# upgrade below and the review lifecycle's roles refuse to dispatch, by name.
# NOTE (FG-583): the flat cp above does NOT publish the atomic seed generation that
# dispatch reads, so it is never enough on its own. Dispatch reads only the published
# generation: on a fresh host with none published it REFUSES (there is no flat-layout
# fallback) and names `forge upgrade` as the fix; on a host that already published one
# the running seeds stay on the prior generation until you republish. Either way, also
# run `./bin/forge-dev upgrade --skip-git --skip-npm --skip-project` to publish/republish
# the generation. There is no standalone CLI that publishes a generation — only forge
# upgrade does.
bash docker/build.sh                # rebuild the agent image (only if a build input changed:
                                    # the Dockerfile or a script it COPYs)
cd ~/code/<your-project>
forge init                          # only if this project has the orchestrator block
forge doctor                        # release check: image, runtime CLIs, auth, policies, seed drift
```

This mirrors `forge-dev upgrade` step-for-step, plus the two things the command makes optional/automatic: the image rebuild (`forge-dev upgrade --rebuild-image`) and the release check that runs automatically at the end of every upgrade (here run by hand as `forge doctor`). The two things the hand-run `install-seeds.sh` cannot reproduce are the atomic seed-generation publish and the agent protocol region publish `forge upgrade` does (see the notes above) — the manual `cp` refreshes only the flat copies. Knowing the manual flow makes the CLI command unnecessary if you ever need to debug something — and it is exactly the flow a release refuses to run for you.

## What the upgrade does NOT do

- **Does not rebuild the agent Docker image by default.** If any of the image's build inputs changed, pass `--rebuild-image` to handle it in the same command (`forge-dev upgrade --rebuild-image`), or run `./docker/build.sh` separately. Both are dev-checkout operations: rebuilding runs a script from, and bakes an image out of, the checkout, so **a release refuses `--rebuild-image`** rather than build from a tree it isn't executing from. A build input is `docker/agent-dev-worker.Dockerfile` **or any file the Dockerfile `COPY`s** — currently `docker/forge-test.sh` (the in-image test wrapper) and `docker/agent-entrypoint.sh`. Editing one of those scripts leaves the built image stale even though the Dockerfile's own mtime never moved, which is exactly the case that used to slip through. Forge will keep using the old image until you rebuild — usually fine, but watch for breakage if the image picked up something load-bearing (e.g. a new tool in PATH, or a changed test-wrapper exit contract).
- **Does not judge image staleness from a release.** In **dev** mode, `forge doctor` (and the release check at the end of `forge upgrade`) compares the image's build timestamp against the newest of all build inputs and reports `STALE` when it's behind. Under a **release** that comparison is suppressed and the check reports presence only: a release tree is materialized by copy, which does not preserve timestamps, so every bundled build input is stamped at release-build time and would read as newer than any image — reporting every release host permanently `STALE`, and naming a rebuild that refuses there. Rebuild advice is mode-aware and points a release host at `forge-dev upgrade --rebuild-image`. (The heuristic's wider false-positive class is FG-543.)
- **Does not touch the SQLite DB.** Schema migrations (rare) happen at next forge invocation when the DB opens. No upgrade-time action needed.
- **Does not refresh other projects' CLAUDE.md.** Only the cwd's, and only if the block exists. See "Updating multiple projects" above.
- **Does not restart any running orchestrator sessions.** If a Claude Code session has the orchestrator block loaded, it stays on the old template until restart. Restart the session to pick up new orchestrator behavior.
