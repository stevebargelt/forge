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

1. **`git pull --ff-only`** in the dev checkout (`~/code/forge` by default; override via `--forge-repo` or `FORGE_REPO_DIR`). Does not pull if the working tree is dirty — protects in-progress forge changes, and exits 1, because you asked for advancement and did not get it. **Refused under a promoted release** — see [Execution mode](#execution-mode-what-upgrade-will-and-wont-do) below.
2. **`npm install`** in the dev checkout. Picks up new top-level deps and new workspace deps (e.g. the `dashboard/` workspace's `marked` after #140). **Refused under a promoted release.**
3. **`FORCE=1 ./scripts/install-seeds.sh`**, run from the forge that is executing. It refreshes the **forge-owned** seeds — `~/.forge/workflows/` and `runtimes/` — plus the host/orchestrator skills in `~/.claude/skills/` (user-global, not `~/.forge/`). The **operator-authored** seeds — `~/.forge/agents/`, `constraints/`, and `forge-raci.md` — are **create-only**: installed when absent, **retained** when present, even under `FORCE=1` (FG-578). Forge seeds them once and never writes over them again, so a gated `forge raci apply` change or a local edit to an agent/constraint prompt survives every upgrade; when a retained file differs from this release's seed, upgrade prints a ⚠ naming it as *not refreshed* (see the output note below) — it is out of forge's control path and yours to merge. This step also **migrates `model-policy.yml`** (FG-560) — see [model-policy schema versioning and migration](how-to-model-policy.md#schema-versioning-and-migration) for the full contract: it enumerates the host policy plus every discovered project policy (historical/best-effort — never a fleet inventory), migrates every safely-migratable file atomically per-file (adding the `spec-writer`/`fast-orchestrator` compatibility aliases and stamping `schema_version: 2`), and leaves a file needing a human decision, an unreachable checkout, or a newer-than-supported policy unchanged — any of those makes the run non-success. `forge upgrade` is the *only* thing that ever migrates this file; ordinary policy loading at dispatch time is strictly read-only and refuses a non-current policy instead. Upgrade then **recompiles the derived `~/.forge/routing-policy.yml`** from the host RACI, whether that RACI was freshly created or retained. The routing policy is generated, never hand-maintained, so upgrade regenerates it in lockstep; you never run `forge route compile` by hand after an upgrade. A compile failure is reported loudly with the exact reason (the specific rejected RACI construct) and the rest of the upgrade still runs, but the promoted runtime will **not** let the previous runtime's compiled `routing-policy.yml` stay silently authoritative when it can no longer vouch for the RACI that policy derives from: it **invalidates** the stale policy in place — quarantining it to `routing-policy.yml.quarantined` (or, if that rename can't happen, removing it; and if neither can, saying so loudly and telling you to remove it by hand). A missing host policy is itself fail-closed — routing falls back to lane `manual` / `policy_not_found` — so this leaves routing safe rather than running under a policy the new runtime rejects. The warning names the rejected construct and the repair (`fix $FORGE_HOME/forge-raci.md, then run: forge route compile` — the path follows `FORGE_HOME`, so under a non-default `FORGE_HOME` the refusal names the actual file there, not `~/.forge/`), and the run closes `INCOMPLETE` and exits 1. A host with no RACI at all is not a failure — there is no derived artifact to keep in lockstep. As the last part of this step, upgrade **publishes the forge-owned, dispatch-coupled surface — the workflow and runtime YAMLs, the Forge-owned agent protocols, plus that derived routing policy — as one atomic *seed generation*** (FG-583): a complete generation is staged and committed with a single `rename(2)` over a dedicated seed pointer, sourced strictly from the executing release's own bundled `seeds/`. **This published generation is what dispatch actually reads** (`forge next`, gate advances, campaign items), not the flat `~/.forge/workflows`/`runtimes`/`routing-policy.yml` the installer also writes (the agent protocols have no flat copy at all — the installer writes none, so `forge upgrade` is the only thing that moves them) — those flat copies are retained only for the seed-drift detector and `forge doctor`'s runtime-registry enumeration. A concurrent `forge next` therefore observes either the whole generation that was current before the upgrade or the whole one this upgrade publishes — never a torn or old/new-mixed set; a dispatch already running stays anchored to the generation it opened. If the publication fails or is interrupted, the prior generation is left intact and selectable, the failure is reported by name, and the run closes `INCOMPLETE` and exits 1 — a partial install is never reported healthy, and every dispatch entry refuses to run under an *incomplete* generation (naming the state and pointing at `forge upgrade`) rather than dispatching under a set no release shipped.
4. **Provision the current project** (when the cwd's `CLAUDE.md` looks like a forge project — a fence marker *or* a `# forge orchestrator` heading). This **always** installs/refreshes the per-machine pieces — the operator adapters (`/orient` + `/handoff` as Claude Code slash commands, and the same two workflows as `forge-orient` / `forge-handoff` Codex repository-scoped skills under `.agents/skills/`), Claude session hooks, `.gitignore` entries (including one per Codex skill directory) — because those are machine-local and not committed, so every new machine needs them even when `CLAUDE.md` is committed. The adapters are rendered bytes carrying a Forge ownership marker and a release stamp, refreshed whenever the installed bytes differ from what the running release renders; a project-owned file at an adapter path (no marker, or a foreign symlink) is left alone and reported, never overwritten. It then refreshes the orchestrator **block**: replaced in place when fenced (head/tail preserved); **repaired** when only the end marker is present (start re-inserted before the heading); and for an unfenced legacy block or a lone start marker it leaves the block untouched and prints exactly which markers to add (the end can't be inferred without risking your project-specific tail). `forge init` is for genuinely new projects; `forge upgrade` is the path for existing ones (#231).

Output is compact — one line per step, plus any operator-authored seeds the install **retained** (a ⚠ block naming each file forge did *not* overwrite and did *not* count as refreshed — `agents/`, `constraints/`, or `forge-raci.md` whose copy diverges from this release's seed) and any orphan-warnings from the seeds install. After the steps complete, a read-only release check runs automatically — it verifies the agent image, in-image runtime CLIs, auth credentials, policies, and seed drift (installed `~/.forge` seeds vs the running code), surfacing any problems before the next dispatch. Run `forge doctor` for the full report. `forge doctor` additionally names an **incomplete** seed generation — a seed pointer that resolves to a torn or mid-publish generation carrying no valid provenance manifest — as a repairable state (`Seed install: INCOMPLETE (repairable)`), prints the fix (`forge upgrade`, which republishes a complete atomic generation), surfaces it in `--json` as a `seedInstall` block, and exits non-zero. `forge doctor` likewise names a host that has **never published a generation** — the flat pre-migration layout, a fresh or not-yet-upgraded host — as `Seed install: NOT INSTALLED`: dispatch reads only a published generation and there is no flat-layout fallback, so the loader refuses to dispatch until one is published. Doctor prints the same `forge upgrade` fix, surfaces the `no-generation` state in the `--json` `seedInstall` block, and exits non-zero. Only a **complete published generation** is healthy — both a torn/mid-publish generation and a never-published one are readiness problems `forge upgrade` repairs. Generation state is not the whole readiness verdict, though: doctor also measures the **Forge-owned agent protocol** for each of the nine roles the review lifecycle dispatches, and a role whose protocol is missing from the generation, torn, behind this release, still embedded in your own agent seed, or absent from the running release itself is a `[FAIL]` that exits non-zero too. In `--json` that verdict rides in a `protocolDrift` block — `{ ok, entries: [{ role, ok, detail }], stale }`, one `entries` row per covered role and `stale` holding only the failing ones — and the human summary prints the same rows, when any role is stale, under the heading `Forge-owned agent protocol (published seed generation):`; `protocolDrift.ok` joins `seedInstall`'s health in the same conjunction that decides doctor's exit code. `forge upgrade` repairs the first three. It repairs neither of the last two — an embedded copy lives in a file forge does not write, so that one names a hand edit and waits for you, and a release missing a covered role's protocol is repaired by reinstalling the release, since publication refuses that same file. See [Agent seeds and the Forge-owned protocol](#agent-seeds-and-the-forge-owned-protocol).

The check is skipped in two cases, and says which: on a `--dry-run` (nothing was installed to check), and when `install-seeds.sh` did not install, because a verdict would then describe a `~/.forge` this upgrade never touched — a stale state presented as a fresh verdict is worse than no verdict. If the check itself crashes, that is a state nobody verified rather than a nicety that was skipped: it exits 1.

`forge doctor` separately reports **project-scoped** orientation/handoff adapter drift — this project only, never another checkout on the host — using the same forge-owned-vs-operator-owned split as the seed report above, but measured against `.claude/commands/` and `.agents/skills/forge-orient` / `forge-handoff` in the current project. A forge-owned adapter whose stamp doesn't match this release is a warning (`forge upgrade` converges it — misleading guidance, never a mis-run, so it doesn't move doctor's exit code); a file with no forge ownership marker is reported as yours and never listed under that remedy. Separately again, at **launch** (`forge claude` / `forge orchestrator`), Forge checks whether the project's installed adapters agree with the generation *that launch* resolved and records any disagreement as a capability limitation on the receipt — printed as a console advisory too when the launch is Claude Code — see [Orientation/handoff adapters, and the generation-split advisory](how-to-orchestrator-launcher.md#orientationhandoff-adapters-and-the-generation-split-advisory) in the launcher doc. Neither check ever blocks: installed bytes are misleading prose at worst, not a silent mis-run.

Every step's outcome — including whether it did what you asked — is available machine-readably via [`--json`](#--json-the-machine-readable-result).

> `forge upgrade` does **not** rebuild the agent Docker image or run provider login by default. To rebuild after changing any of the image's **build inputs** — the Dockerfile *or* any file it `COPY`s (today `docker/forge-test.sh`, `docker/agent-entrypoint.sh`, `docker/forge-backlog-reader.mjs` and `docker/forge-backlog-bin.sh`) — add `--rebuild-image` **from a dev checkout**; it is refused under a release. Auth credentials (`codex login` / `forge auth login`) are per-machine; run `forge doctor` after upgrade to verify auth and policy readiness (#229).

## Execution mode: what upgrade will and won't do

`forge upgrade` has **two halves**, and which of them run depends on what the `forge` you typed actually is (FG-577):

- **Asset installation** (steps 3 and 4 — host seeds, the host/orchestrator skills, the routing-policy recompile, the project's orchestrator template) always installs the bytes of **the forge that is executing**, resolved relative to its own module. Under `forge-dev` or an npm-linked checkout that's your working tree; under a promoted release it is the **release's own** bundled `seeds/` and `scripts/install-seeds.sh`. It reads `~/code/forge` in neither case.
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
| model-policy migration | ≥1 discovered policy needs a human decision, is unreachable, or is newer than this forge supports (left unchanged); or a discovered file could not be migrated (write/parse failure — its original is left intact) |
| seed generation publication | the atomic publish failed or was interrupted (the prior generation stays intact and selectable) |
| routing-policy recompile | a host RACI exists and would not compile |
| project init | no `CLAUDE.md` here; `CLAUDE.md` has no forge block; the template is missing from the executing tree; the block needs manual markers |
| `--rebuild-image` | refused (release); the build failed |
| release check | it crashed |

Each of these previously exited 0 and printed `Upgrade complete.` while the requested action had not happened. If you have a script that treats exit 0 as "forge is current," it was reading a success that wasn't there in every row above.

What does **not** exit 1: anything nobody asked for. An operator skip (`--skip-git`, `--skip-npm`, `--skip-project`), a checkout that simply isn't on this host, no remote configured, no `package.json`, no host RACI, and a block that was already current are all **resolved** — they exit 0. An operator saying no is not a failed request.

A **project-local adapter override** is on that list too, and deliberately so: if your project ships its own `.claude/commands/orient.md` (or its own `.agents/skills/forge-orient/SKILL.md`), forge will not clobber a file it doesn't own, prints a ⚠ saying the adapter was not installed, and exits 0. Your project owning that path is an answer, not a defect, and an exit code that fired forever on every project that gave one would be noise. It is still a *state* rather than a silence — `--json` reports the Claude-only subset as `slashCommands: "user-override"` with the affected commands named in `slashCommandOverrides`, and the **whole adapter set** (Claude commands and Codex skills together) as `adapterSurfaces: "user-override"` with every overridden path named in `adapterOverrides`, so a script sees exactly what the ⚠ said either way. To take forge's version, remove the file and re-run.

Two consequences worth internalizing, because they change how you script this:

- **A release-mode `forge upgrade` exits 1 only for the advancement you actually asked for.** The rule above is the whole rule — an operator skip outranks the mode refusal, because you cannot refuse what was never requested. So the release-host recipes come out like this:

  | On a release | git pull | npm install | Exit |
  |---|---|---|---|
  | `forge upgrade` | `REFUSED` | `REFUSED` | 1, `INCOMPLETE` |
  | `forge upgrade --skip-git` | `skipped (--skip-git)` | `REFUSED` | 1, `INCOMPLETE` |
  | `forge upgrade --skip-npm` | `REFUSED` | `skipped (--skip-npm)` | 1, `INCOMPLETE` |
  | `forge upgrade --skip-git --skip-npm` | `skipped (--skip-git)` | `skipped (--skip-npm)` | 0, `Upgrade complete.` |

  The two steps are classified independently, so `--skip-git` alone leaves your skip standing on step 1 while step 2 is still genuinely refused. **`forge upgrade --skip-git --skip-npm` is the way to refresh `~/.forge/` from a release host with a zero exit.** It exits 0 because nothing you asked for was refused — *not* because a release can advance a checkout. It still cannot: you asked for the asset half only, and the asset half is all that ran. Bare `forge upgrade` on a release still exits 1, and should: you asked for the full dance and half of it cannot happen. In every row the asset half succeeds — a nonzero exit says "not everything you asked for happened," not "nothing worked."
- **`--dry-run` can exit 1.** It mutates nothing, but it is a report an operator acts on, so its exit code and its `--json` `ok` agree with each other and are decided the same way as a real run: any state a dry run *can* observe without executing — the release refusal of `git pull`/`npm install`, a dirty checkout, a missing `install-seeds.sh`, a RACI that won't compile, a project with no forge block or no `CLAUDE.md` — makes the dry run exit 1 and print `Dry run: this upgrade would NOT complete — …`. (One gap worth knowing: a dry run reports `--rebuild-image` as `would-rebuild` without deciding it, so it does not predict the rebuild refusal a release-mode real run would raise.) A dry run that finds nothing wrong says so without implying more than it checked, and closes with what it is structurally blind to:

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

**Asset repair needs no dev checkout at all.** This is deliberate: `~/.forge` being broken or drifted is exactly when you need `forge upgrade`, so a release repairs its **forge-owned** host seeds from its own bundled assets even on a machine that has never cloned forge. (Operator-authored seeds — `agents/`, `constraints/`, `forge-raci.md` — that have diverged are retained, not repaired; see [When to upgrade](#when-to-upgrade) and the `authoredRetention` field below.) A refusal never blocks that half — steps 3 and 4 run in the same command that refused steps 1 and 2. To ask for that half and nothing else — the clean-exit release recipe — pass `forge upgrade --skip-git --skip-npm`. If the checkout is simply absent in dev mode, steps 1 and 2 report `SKIPPED` (nothing was refused and nothing failed, so the exit code stays 0).

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

`--dry-run` is the right thing to try first if you're unsure what an upgrade will do — it prints the four-step plan with what each would do, then exits. Note that it can exit 1, and that a clean dry run is not a promise of a clean upgrade — see [Execution mode](#execution-mode-what-upgrade-will-and-wont-do).

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
  "modelPolicy": "migrated",
  "modelPolicies": [
    { "scope": "host", "projectDir": "/Users/you/.forge", "policyPath": "/Users/you/.forge/model-policy.yml", "discoveryState": "has-policy", "verdict": "migratable", "action": "migrated", "detail": "adds defaults.activity.spec-writer, defaults.activity.fast-orchestrator" }
  ],
  "authoredRetention": "retained",
  "authoredRetentions": ["forge-raci.md"],
  "routingPolicy": "recompiled",
  "routingPolicyError": null,
  "projectInit": "refreshed",
  "slashCommands": "installed",
  "slashCommandOverrides": [],
  "adapterSurfaces": "installed",
  "adapterOverrides": [],
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
| `seedGeneration` | `"published" \| "would-publish" \| "not-run" \| "failed"` | Unresolved on `failed`. The atomic publication of the dispatch-coupled generation (workflows + runtimes + the Forge-owned agent protocols + derived routing policy). `not-run` = no release seeds to publish from (the asset install already reported that); `failed` = the publish failed, was interrupted, or was refused — the executing release carrying no protocol for a covered role is one such refusal (FG-654) — and the prior generation is left intact; a partial install is never reported healthy |
| `seedGenerationError` | `string \| null` | The publication's verbatim failure reason on `failed` — the same named refusal the human warning prints; `null` on every non-`failed` path |
| `modelPolicy` | `"none" \| "all-current" \| "migrated" \| "would-migrate" \| "action-required" \| "failed" \| "not-run"` | Unresolved on `action-required` (≥1 discovered policy left unchanged — needs a human decision, is unreachable, or is newer-unsupported) and `failed` (a discovered file could not be migrated; its original is left intact). `migrated`/`would-migrate` differ only on `--dry-run`, keyed off the same per-file verdict so the forecast can't disagree with the real run |
| `modelPolicies` | array | One entry per discovered policy (host + every discovered project) — `{ scope, projectDir, policyPath, discoveryState, verdict, action, detail }`. `discoveryState` is the [discovery state](how-to-model-policy.md#discovery-is-historical-and-best-effort--never-a-fleet-inventory) (`has-policy`/`reachable-no-policy`/`unreachable-deleted`/`known-but-no-path`); `verdict` is the per-file classifier outcome (`current`/`migratable`/`changed-if-applied`/`needs-human-decision`/`newer-unsupported`, or `null` when there was no file to classify); `action` is what actually happened (`migrated`/`would-migrate`/`current`/`needs-human-decision`/`newer-unsupported`/`unreachable`/`no-policy`/`known-no-path`/`failed`) |
| `authoredRetention` | `"none" \| "retained" \| "not-run"` | Never unresolved. `retained` = forge left ≥1 operator-authored seed in place because your copy diverges from this release's seed; `none` = nothing to retain; `not-run` = the installer never ran, so nothing was inspected (not the same as `none`) |
| `authoredRetentions` | string[] | Which operator-authored seeds (`agents/`, `constraints/`, `forge-raci.md`) forge did NOT overwrite — paths relative to `~/.forge/`, the same set the human ⚠ names. Informational, never a failure; it is the only place a script learns those files are running unrefreshed. Empty unless `authoredRetention` is `retained` |
| `routingPolicy` | `"recompiled" \| "would-recompile" \| "no-raci" \| "failed" \| "failed-not-neutralized"` | Unresolved on `failed` and `failed-not-neutralized`. `failed` = the promoted runtime rejected the host RACI, so the stale compiled policy was **invalidated** (quarantined to `routing-policy.yml.quarantined`, or removed) and routing is fail-closed until the RACI compiles — never left silently authoritative. `failed-not-neutralized` is the **exceptional** case: the RACI was rejected **and** neither the rename nor the fallback removal could take the stale policy off disk, so it is **still authoritative and routing is NOT fail-closed** — you must remove it by hand (`rm $FORGE_HOME/routing-policy.yml` — the refusal names the actual path under your `FORGE_HOME`, not `~/.forge/`) before routing fails closed. `no-raci` is fine — no derived artifact to keep in lockstep |
| `routingPolicyError` | `string \| null` | The compiler's verbatim reason for the rejected RACI construct — the same named refusal the human warning prints. `null` on every non-`failed`/non-`failed-not-neutralized` path. On `failed-not-neutralized` it also carries the neutralization failure (the policy is still authoritative; remove it by hand) |
| `projectInit` | `"refreshed" \| "already-current" \| "would-refresh" \| "skipped" \| "no-claude-md" \| "no-forge-block" \| "template-not-found" \| "needs-markers"` | Unresolved on the last four |
| `slashCommands` | `"installed" \| "already-current" \| "would-install" \| "user-override" \| "not-run"` | Never unresolved. Claude-only subset of `adapterSurfaces` below. `user-override` = this project already owns at least one of the Claude command paths, so forge left it alone; `not-run` = project provisioning didn't reach this step (`--skip-project`, or no forge block) |
| `slashCommandOverrides` | string[] | Which Claude commands were not installed and why — the same set the human ⚠ names. Empty unless `slashCommands` is `user-override` |
| `adapterSurfaces` | `"installed" \| "already-current" \| "would-install" \| "user-override" \| "not-run"` | Never unresolved. The **whole** operator-adapter set — Claude commands and Codex skills together, classified from the same plan `slashCommands` reads its Claude-only subset from. `user-override` = the project already owns at least one adapter path on *either* surface; `not-run` = project provisioning didn't reach this step |
| `adapterOverrides` | string[] | Every adapter target forge left alone because the project already owns that path — Claude commands and Codex skills alike, named by label (`/orient`, `forge-orient`, …) and repo-relative path. Empty unless `adapterSurfaces` is `user-override` |
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

## Agent seeds and the Forge-owned protocol

Your `~/.forge/agents/<role>/CLAUDE.md` is **operator-authored, whole-file** (FG-578): forge creates it when absent and never writes over it again — not under `FORCE=1`, not from any install path, and `forge upgrade` included. There is no region inside it that forge owns, no adoption pass, and no `.bak` file: since FG-654 the **Forge-owned review protocol** — the contract a dispatched reviewer's output is judged against — is not in that file at all. It is `seeds/agent-protocols/<role>.md`, a forge-owned category of the atomic seed generation, and compose puts it in the prompt **ahead of** your prose. Editing your seed can never make the host read as stale; republishing the protocol can never touch a line you wrote.

Nine roles are covered: the five `red-*` discovery lenses plus `engineer`, `documentation-maintainer`, `review-rechecker`, and `shipping-reviewer`. A covered role is REFUSED at dispatch — by name, before any container or task dir exists — in six states, all of which `forge doctor` also reports as a readiness `[FAIL]`:

| State | What it means | Remedy |
| --- | --- | --- |
| no generation published | this host has never run `forge upgrade` | `forge upgrade` |
| protocol missing from the generation | the generation predates the protocol category | `forge upgrade` |
| protocol torn / tampered | the bytes on disk do not match the generation's provenance manifest | `forge upgrade` |
| protocol **stale** | the generation is internally fine but its bytes are not the running forge's — you installed a newer release, or re-ran `install-seeds.sh`, without publishing | `forge upgrade` |
| **embedded legacy protocol in your seed** | your `~/.forge/agents/<role>/CLAUDE.md` still contains a copy of the protocol | **you delete that section by hand** — see below |
| the running release carries no protocol for the role | the forge you are executing has no `seeds/agent-protocols/<role>.md`, so there is nothing left to measure the published generation's currency against — an incomplete or damaged install | **reinstall the release** (`forge upgrade` refuses the same missing file) |

### The embedded-legacy-protocol refusal (what most existing hosts will hit)

Every host seeded before FG-654 has a protocol *inside* its agent seeds — either a `<!-- forge:agent-protocol-start -->` marker-fenced region (hosts upgraded during the region era) or the protocol's `## ` sections inline (older seeds carried them directly). Composing the prompt would then deliver the contract twice, the embedded one contradicting the current one, so forge refuses that role's dispatch and names the file and the section:

```
agent role "red-wide"'s installed seed at ~/.forge/agents/red-wide/CLAUDE.md carries an embedded copy of the
Forge-owned review protocol: it still contains the section '## Evidence anchoring (#147)', which this release's
protocol owns. … Forge does not rewrite your file: delete the embedded protocol section (or the marker-fenced
region) from that file by hand, then retry. Nothing was written and no backup was made.
```

**`forge upgrade` will not fix this for you, and re-running it changes nothing.** That is the deliberate consequence of the ownership rule: the file is yours, so the deletion is yours. Open the named file, delete the marker-fenced region (markers included) or the `## ` sections the refusal names, keep everything else, and re-run. Your own prose, house rules and role notes stay exactly where they are — they were never part of the protocol. `forge doctor` names every role still in this state, so you can clear them in one pass rather than discovering them one refused dispatch at a time.

One further state exists on the publishing side rather than the dispatching one, and it is the other half of the table's last row: a release that carries no `seeds/agent-protocols/<role>.md` for a covered role **cannot publish a generation at all**. `forge upgrade` refuses the publish by name, leaves the previous generation selectable, and closes `INCOMPLETE` — rather than reporting a healthy publish for a host on which that one role would refuse at every dispatch. That refusal only governs a generation being *created*, which is why the dispatch side refuses the same missing file independently: a host that published under a complete release and then installed a damaged one already holds a generation nothing republishes. The remedy for both is reinstalling the release, not another upgrade.

## When to upgrade

- **After pulling new forge commits.** The `git pull` step is the trigger. From a dev checkout; a release has nothing to pull.
- **After editing local forge source.** Run `forge-dev upgrade --skip-git` so the existing dirty tree doesn't block the rest of the flow; seeds still get refreshed and the project block re-inits against your local changes. Use `forge-dev`, not `forge`: the stable `forge` installs the promoted release's seeds, not your edits.
- **When a seed change won't take effect.** The orchestrator template and workflow/runtime YAMLs live in `~/.forge/` after install. Editing `seeds/*` in the forge source doesn't update `~/.forge/*` until an install runs — and only the forge you actually run installs its own copy, so `forge-dev upgrade --skip-git --skip-npm` is the shortest way to get *those* edits into `~/.forge/`. **For workflow and runtime edits, use `forge upgrade`, not `install-seeds.sh` alone** (FG-583): dispatch reads workflows, runtimes, and the derived routing policy from the atomically published *seed generation*, and only `forge upgrade` (dev or release) republishes that generation. `install-seeds.sh` on its own refreshes only the flat `~/.forge/workflows`/`runtimes` copies that the drift detector and `forge doctor`'s registry read — so a flat-only refresh will *not* change what a `forge next` actually runs once a generation has been published. **The agent prompts, constraints, and RACI are a further exception** (FG-578): once installed they are operator-owned, so upgrade retains them and a seed edit will *not* propagate — remove the file's `~/.forge/` copy first so the installer recreates it, or merge your change in by hand.
- **When `~/.forge/` is drifted or broken.** `forge upgrade` is the named remedy for the **forge-owned** seed-drift the release check reports, and it works from a release with no dev checkout on the host — the assets come from the release itself. On a release, ask for that half by name: `forge upgrade --skip-git --skip-npm` refreshes those seeds and exits 0. The authored agent, constraint, and RACI drift called out above is the exception: upgrade retains it, not remedies it — merge it in by hand, or remove the `~/.forge/` copy so the installer recreates it (FG-578).

## When NOT to use `forge upgrade`

- **You only want to test a single local *forge-owned* seed change** (a workflow or runtime YAML, or an `agent-protocols/<role>.md`). `FORCE=1 ./scripts/install-seeds.sh` (in the forge repo) refreshes the flat `~/.forge/` copies, but since FG-583 **that no longer changes what a dispatch runs** — `forge next`, gate advances, and campaigns read workflows and runtimes from the atomically published *seed generation*, and only `forge upgrade` republishes it. Use `forge-dev upgrade --skip-git --skip-npm` to publish a fresh generation from your local seeds (still faster than the full dance, and it is what dispatch will actually read). Editing a protocol in your checkout is the sharpest case: the published generation is then measurably behind the forge you are running, so every covered role refuses `stale` until you republish — deliberately, since the alternative is reviewing under a contract your tree no longer states. Note that any install **will not** push an edit to an already-installed operator-authored seed — `agents/`, `constraints/`, and `forge-raci.md` are create-only and retained when present (FG-578), so reinstalling over them is a no-op. To re-test an edit to one of those, remove its `~/.forge/` copy first so the installer recreates it, or copy the file in by hand. **For `forge-raci.md` specifically**, the installer only writes the RACI — it does **not** recompile the derived routing policy, and since FG-583 a bare host `forge route compile` **no longer writes the flat file at all**: it validates that the host RACI compiles and directs you to `forge upgrade`, because the routing policy dispatch resolves lives *inside* the seed generation, compiled from the RACI at publish time (the flat `~/.forge/routing-policy.yml` is not a dispatch source). So after recreating or hand-copying the RACI, run a full `forge upgrade` (dev: `forge-dev upgrade --skip-git --skip-npm`) to republish the generation with the recompiled policy; otherwise the routing a dispatch resolves still reflects the *old* RACI you just replaced.
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

This mirrors `forge-dev upgrade` step-for-step, plus the two things the command makes optional/automatic: the image rebuild (`forge-dev upgrade --rebuild-image`) and the release check that runs automatically at the end of every upgrade (here run by hand as `forge doctor`). The one thing the hand-run `install-seeds.sh` cannot reproduce is the atomic seed-generation publish `forge upgrade` does (see the note above) — the manual `cp` refreshes only the flat copies. Knowing the manual flow makes the CLI command unnecessary if you ever need to debug something — and it is exactly the flow a release refuses to run for you.

## What the upgrade does NOT do

- **Does not rebuild the agent Docker image by default.** If any of the image's build inputs changed, pass `--rebuild-image` to handle it in the same command (`forge-dev upgrade --rebuild-image`), or run `./docker/build.sh` separately. Both are dev-checkout operations: rebuilding runs a script from, and bakes an image out of, the checkout, so **a release refuses `--rebuild-image`** rather than build from a tree it isn't executing from. A build input is `docker/agent-dev-worker.Dockerfile` **or any file the Dockerfile `COPY`s** — currently `docker/forge-test.sh` (the in-image test wrapper) and `docker/agent-entrypoint.sh`. Editing one of those scripts leaves the built image stale even though the Dockerfile's own mtime never moved, which is exactly the case that used to slip through. Forge will keep using the old image until you rebuild — usually fine, but watch for breakage if the image picked up something load-bearing (e.g. a new tool in PATH, or a changed test-wrapper exit contract).
- **Does not judge image staleness from a release.** In **dev** mode, `forge doctor` (and the release check at the end of `forge upgrade`) compares the image's build timestamp against the newest of all build inputs and reports `STALE` when it's behind. Under a **release** that comparison is suppressed and the check reports presence only: a release tree is materialized by copy, which does not preserve timestamps, so every bundled build input is stamped at release-build time and would read as newer than any image — reporting every release host permanently `STALE`, and naming a rebuild that refuses there. Rebuild advice is mode-aware and points a release host at `forge-dev upgrade --rebuild-image`. (The heuristic's wider false-positive class is FG-543.)
- **Does not touch the SQLite DB.** Schema migrations (rare) happen at next forge invocation when the DB opens. No upgrade-time action needed.
- **Does not refresh other projects' CLAUDE.md.** Only the cwd's, and only if the block exists. See "Updating multiple projects" above.
- **Does not restart any running orchestrator sessions.** If a Claude Code session has the orchestrator block loaded, it stays on the old template until restart. Restart the session to pick up new orchestrator behavior.
