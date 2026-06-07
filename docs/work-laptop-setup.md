# New or work laptop: forge-on-forge setup checklist

Use this when getting forge running on a new or fresh work machine. The goal is a host where `forge setup` reports no blocking failures for the profiles you actually use.

**Prerequisites:** Docker running, Node 20+, Git.

---

## 1. Clone and link

```bash
git clone <your-forge-repo-url> ~/code/forge
cd ~/code/forge
npm install
npm link                    # puts `forge` on $PATH
```

Verify: `forge --help` lists the commands.

## 2. Install seeds and (optionally) build the agent image

```bash
cd ~/code/forge
forge upgrade --skip-git                     # installs seeds, recompiles routing policy
forge upgrade --skip-git --rebuild-image     # also builds the agent Docker image (~5–10 min first time)
```

`forge upgrade` refreshes `~/.forge/` — agent seeds, constraints, workflow YAML, the RACI, and the derived routing policy. Add `--rebuild-image` when the agent image hasn't been built on this machine yet.

> `--skip-git` avoids a "no remote" skip message if you haven't configured an upstream yet. Drop it once you have.

## 3. Create the active model policy and run the readiness check

```bash
forge setup
```

Three things happen in one step:

1. **Creates `~/.forge/model-policy.yml`** from `model-policy.example.yml` — only when the active policy is absent. An existing policy is never overwritten.
2. **Compiles `~/.forge/routing-policy.yml`** from the RACI seed. This file is generated, not hand-maintained.
3. **Runs a read-only release check** — agent image, in-image runtime CLIs (`claude`, `codex`, `pi`), per-profile provider auth, model and routing policy validity. No live agent run; everything is verified statically.

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

Re-run after resolving each credential. When `forge setup` reports "Ready: no blocking failures", the host is ready to dispatch agents.

Use `forge doctor` any time you want to recheck readiness without touching files.

---

## Quick reference

| Command | What it does |
|---|---|
| `forge upgrade [--rebuild-image]` | Pull forge commits, refresh `~/.forge/`, recompile routing, re-init project, run release check |
| `forge setup [--dry-run]` | Create active model/routing policy from seed if absent, run release check |
| `forge doctor` | Read-only release check (image, CLIs, auth, policies) — no writes |
| `forge auth login` | Wire Claude subscription credentials into the forge OAuth volume |

## What not to do

- **Don't hand-edit `routing-policy.yml`** — it is generated from the RACI. Edit the RACI and let `forge setup` or `forge upgrade` recompile it.
- **Don't commit `~/.forge/*`** — this directory is host-local. Each machine gets its own policy and credentials.
- **Don't skip `forge setup` on a new machine** and jump straight to `forge new feature` — the model policy won't exist and dispatch will fail or run in legacy mode.
