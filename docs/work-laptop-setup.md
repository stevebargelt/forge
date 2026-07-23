# New or work laptop: forge-on-forge setup checklist

Use this when getting forge running on a new or fresh work machine. The goal is a host where `forge setup` reports no blocking failures for the profiles you actually use.

**Prerequisites:** Docker running, a Node on ABI 137 — `nvm use` in the repo root installs the pin from `.nvmrc` (currently 24), Git.

> The requirement is a matching ABI, not a floor and not one exact Node version. Forge's better-sqlite3 binding is compiled for one ABI (137) and loads under that ABI only, so a mismatched Node — **older or newer** — is refused at startup with a named message naming the ABI it found and the one it needs. The preflight checks the ABI, not the version string, so any Node on ABI 137 starts; the `.nvmrc` pin is the tested and supported way to get one. (`package.json` engines `^24` tracks `.nvmrc` and flags this earlier, at install time.) Run `nvm use` before the steps below; if forge refuses later, that's the fix.

---

## 1. Clone, then build and promote a release

```bash
git clone <your-forge-repo-url> ~/code/forge
cd ~/code/forge
npm install

./bin/forge-dev release build --out ~/forge-releases/r1        # --out must not exist, outside the checkout
./bin/forge-dev release promote ~/forge-releases/r1            # atomic; `forge release rollback` reverses it
./bin/forge-dev release install-shim --prefix /usr/local/bin   # once; any directory on your $PATH
```

The machine-wide `forge` is a promoted, immutable release run by its own pinned interpreter — not the checkout. `./bin/forge-dev` is the live-source entry, used here to bootstrap because no stable `forge` exists yet on a fresh machine; keep using it when you're iterating on forge itself. `npm link` is not the install path: it would put a live-checkout `forge` on `$PATH` and bypass the release split entirely.

The build refuses a dirty checkout — it binds the release to a commit, so commit or stash first.

Verify: `forge --help` lists the commands; `forge release current` names the release you promoted.

## 2. Install seeds and (optionally) build the agent image

Step 1 left this machine with a promoted release on `$PATH`, so drive this step through **`./bin/forge-dev`** — the checkout entry — not the stable `forge`:

```bash
cd ~/code/forge
./bin/forge-dev upgrade --skip-git                   # installs seeds, recompiles routing policy
./bin/forge-dev upgrade --skip-git --rebuild-image   # also builds the agent Docker image (~5–10 min first time)
```

`forge upgrade` refreshes `~/.forge/` — on this first run `~/.forge/` is empty, so it installs everything (agent seeds, constraints, workflow and runtime YAML, the RACI) and compiles the derived routing policy. On later upgrades the forge-owned seeds — `~/.forge/`'s workflows and runtimes, plus the `forge-*` skills in the user-global Claude Code skills dir (`~/.claude/skills`, not `~/.forge/`) — refresh, but your agent, constraint, and RACI edits are seeded once and then retained — forge never overwrites them, `FORCE=1` included (FG-578). Add `--rebuild-image` when the agent image hasn't been built on this machine yet.

Check the exit code here rather than the scrollback: if the image build fails, or the seed install, the atomic seed-generation publish, or the routing-policy recompile doesn't land, upgrade closes `Upgrade INCOMPLETE — <reasons>` and exits 1 instead of `Upgrade complete.` On a fresh machine that is the signal worth trusting — a long image build's failure is easy to miss in the output.

> **Why `forge-dev` here.** Building the agent image is dev-checkout work — it runs `docker/build.sh` from the checkout — so the stable `forge` **refuses `--rebuild-image`** under a release and points you back at the checkout (FG-577). The stable `forge` would also exit nonzero on `forge upgrade --skip-git` — your skip stands on the pull, but the `npm install` you did not skip is still refused under a release — so it closes `Upgrade INCOMPLETE` even though it refreshed your seeds. `forge-dev` executes from the checkout, so both halves simply run. The release you promoted in step 1 was built from this same commit, so the seeds are identical either way.
>
> Seed installation itself is *not* dev-only: `forge upgrade` from the release installs the **release's own** bundled seeds and works on a host with no checkout at all. That's the repair path when `~/.forge/`'s forge-owned seeds are broken or drifted — your authored agent, constraint, and RACI seeds are retained rather than repaired, as above (FG-578) — see `docs/how-to-upgrade.md`.

> `--skip-git` avoids a "no remote" skip message if you haven't configured an upstream yet. Drop it once you have.

## 3. Create the active model policy and run the readiness check

```bash
forge setup
```

Three things happen in one step:

1. **Creates `~/.forge/model-policy.yml`** from `model-policy.example.yml` — only when the active policy is absent. An existing policy is never overwritten.
2. **Refreshes the flat `~/.forge/routing-policy.yml`** from the RACI seed. This file is generated, not hand-maintained — but since FG-583 it is **not** a dispatch source. The routing policy dispatch actually reads is the one compiled **into the atomic seed generation**, which only `forge upgrade` publishes (step 2 above). `forge setup` does **not** publish a generation, so this step alone does not make routing effective for dispatch.
3. **Runs a read-only release check** — agent image, in-image runtime CLIs (`claude`, `codex`, `pi`), per-profile provider auth, model and routing policy validity. No live agent run; everything is verified statically.

> **`forge setup` alone does not make the host dispatch-ready.** Dispatch reads exclusively the seed generation that `forge upgrade --skip-project` publishes (step 2). Until that generation is published the host fails closed — `forge next` and every gate advance refuse with a named, repairable no-generation state (`forge doctor` reports it). If you followed step 2 the generation is already published; `forge setup` here only adds the active model policy and the readiness check. This matches `README.md` and `docs/quick-start.md`.

The report also includes a "review-loop reviewer (codex-subscription)" readiness line so you know whether `forge review-loop` is usable before you need it.

`forge setup` exits 0 when there are no blocking failures. Warnings (missing creds for optional profiles, review-loop not ready) are informational — they don't block ordinary agent work.

Useful flags:
```bash
forge setup --dry-run                 # preview what would be created, no writes
forge setup --review-profile <name>   # check a different reviewer profile
```

## 4. Resolve any flagged credentials

Work through whatever `forge setup` flagged. None of these require a live agent spend:

| What's missing | How to fix |
|---|---|
| Claude subscription auth | `forge auth login` (browser flow inside the container prompt) |
| Codex auth | `codex login` |
| Bedrock (AWS SSO) | `aws sso login --profile <profile>` then `. ~/code/forge/scripts/use-bedrock.sh` |
| Pi / Groq API keys | Set the relevant env var per-host (see `docs/how-to-model-policy.md`) |

**Bedrock, Pi, and Groq are opt-in.** `forge setup` diagnosing them as unavailable is expected and not a blocker unless you plan to use those providers on this machine.

`~/.forge/*` is **host-local personal config and is never committed.** You do not need to hand-write `model-policy.yml` or `routing-policy.yml` — `forge setup` creates both from the seed defaults when they're absent.

## 5. Iterate until green

```bash
forge setup        # re-runs provisioning + readiness check
forge doctor       # read-only readiness check only (no file writes)
```

Re-run after resolving each credential. "Ready: no blocking failures" from `forge setup` means creds, model policy, and the release check are green — but the host is dispatch-ready only once `forge upgrade --skip-project` has published the seed generation (step 2). Setup does not publish it; if you skipped step 2, run `forge upgrade --skip-project` (or `./bin/forge-dev upgrade --skip-git` on a checkout) before dispatching.

Use `forge doctor` any time you want to recheck readiness without touching files.

---

## Quick reference

| Command | What it does |
|---|---|
| `forge upgrade` | Refresh `~/.forge/`'s forge-owned seeds from the running forge (authored agent/constraint/RACI seeds are retained, not overwritten — FG-578), recompile routing, re-init project, run release check. Exits nonzero whenever a requested step didn't happen — under a release that always includes refusing to pull/`npm install` the checkout |
| `forge-dev upgrade [--rebuild-image]` | The same, driven from the checkout: also pulls forge commits, `npm install`s, and builds the agent image (`--rebuild-image` is dev-checkout only) |
| `forge setup [--dry-run]` | Create active model/routing policy from seed if absent, run release check |
| `forge doctor` | Read-only release check (image, CLIs, auth, policies) — no writes |
| `forge auth login` | Wire Claude subscription credentials into the forge OAuth volume |

## What not to do

- **Don't hand-edit `routing-policy.yml`** — it is generated from the RACI. Edit the RACI and let `forge setup` or `forge upgrade` recompile it.
- **Don't commit `~/.forge/*`** — this directory is host-local. Each machine gets its own policy and credentials.
- **Don't skip `forge upgrade --skip-project` on a new machine** — it publishes the seed generation dispatch reads. Without it, `forge new feature` / `forge next` fail closed with a named no-generation state, no matter that `forge setup` ran. `forge setup` adds the model policy and readiness check; it does not publish the generation.

---

## Final release check

Run these to confirm the host is a clean, portable forge-on-forge release candidate. All commands are **read-only** — no agent dispatch, no DB mutation, no live provider spend.

```bash
npm run typecheck              # types clean
NO_NOTIFY=true npm run test:all       # fast canonical gate green (unit tier, no real notifications fire)
NO_NOTIFY=true npm run test:extended  # integration + worktree + dashboard-integration green
forge setup --dry-run          # readiness: image, runtime CLIs, per-profile auth, model+routing policy, Codex review-loop path — no writes, no agent run
forge doctor                   # same release check, also usable outside a setup context
git status --short             # expect a clean working tree
```

- `forge setup --dry-run` and `forge doctor` both run the release check introduced in #229.
- `npm test` alone is the fast unit tier only (~2s) — it does not cover integration, worktree, or dashboard-integration tests, so it isn't sufficient evidence for a release. Run `test:all` and `test:extended` (or confirm CI's `test` and `test-extended` jobs are both green on the release commit) instead.
- Opt-in providers (Bedrock, Pi-Groq, Anthropic-API) reporting as warnings is **expected and not a blocker** — only hard fails block a release.
- All six commands must pass before tagging a release on this host.
