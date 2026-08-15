# How-to: pin models with model-policy (AWN-7 Crawl)

Forge resolves the model for every task in **two independent passes**: a
*capability* (what the task needs — `review`, `reasoning`, …) and a *profile*
(who runs it — provider + auth + a capability→model map). You only deal with
profiles; the capability is inferred from the workflow step / agent role.

Policy is **opt-in**. With no `model-policy.yml`, forge runs exactly as before
(legacy `runtime.models[alias]`); tasks record `resolvedBy: legacy`.

The accepted design lives in
`learnings/decisions/2026-05-30_provider-resolution.md` — this is the operator
quick-start.

## Turn it on

Create one of (project wins over user; it's file-level replacement, not merge):

- User:    `~/.forge/model-policy.yml`
- Project: `<project>/.forge/model-policy.yml`

```yaml
schema_version: 2               # required — see "Schema versioning" below
on_unavailable: fail            # fail loud if the resolved auth isn't available
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription          # subscription | api | bedrock | auto
    map:
      reasoning: { model: claude-opus-4-8,   cost_tier: premium }
      review:    { model: claude-sonnet-4-6, cost_tier: standard }
      default:   { model: claude-sonnet-4-6, cost_tier: standard }
      # spec-writer/fast-orchestrator are the orchestrator-facing activity names
      # (`forge invoke … --model spec-writer` / `fast-orchestrator`). Map them so
      # those EXPLICIT activities hit the map directly instead of falling through
      # to map.default — an explicit activity that hits default is refused
      # `activity_unmapped` (see below). `forge upgrade` seeds these same aliases.
      spec-writer:       { model: claude-opus-4-8,  cost_tier: premium }
      fast-orchestrator: { model: claude-haiku-4-5, cost_tier: cheap }
  claude-bedrock:
    provider: anthropic
    auth: bedrock
    map:
      default: { model: us.anthropic.claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: claude-subscription   # ultimate fallback
  activity:
    reasoning: claude-subscription
    review: claude-subscription
    spec-writer: claude-subscription
    fast-orchestrator: claude-subscription
overrides:
  agents:
    red-security: claude-bedrock # this role always runs on bedrock
```

`auth: auto` resolves to whatever the environment offers
(`CLAUDE_CODE_USE_BEDROCK` → bedrock, `ANTHROPIC_API_KEY` → api, else
subscription); a *pinned* auth (`bedrock`/`api`/`subscription`) fails loud if
unavailable rather than silently switching.

## Schema versioning and migration

`model-policy.yml` carries a root `schema_version`; the current version is `2`.
A file with no `schema_version` key is a v1 (legacy) file.

**Ordinary policy loading is strictly read-only.** Every dispatch that reads
`model-policy.yml` checks the version BEFORE anything else and never rewrites,
migrates, or reinterprets the file:

- **absent / older than current** — refused, naming `forge upgrade` as the fix.
- **current** — proceeds normally.
- **newer than this forge understands** — refused, naming "upgrade Forge" —
  forge never downgrades or reinterprets a newer file as an older schema.

**`forge upgrade` is the SOLE migration authority.** It is the only thing that
ever rewrites your `model-policy.yml`. The migration:

- Copies `reasoning` → `spec-writer` and `fast` → `fast-orchestrator` in
  `defaults.activity` and in each profile's `map`, wherever the destination
  alias is missing and its source exists. **Both existing capability names are
  kept** — this adds compatibility aliases, it does not rename or remove
  `reasoning`/`fast`.
- Never overwrites an alias you already defined.
- Never guesses: if a destination alias is missing AND its source is also
  missing, that map needs a human decision and the **whole file** is left
  unchanged (comments, key order, and unrelated keys are always preserved —
  it's a targeted edit, not a reserialize).
- A profile whose map is only `{ default: ... }` (an intentional catch-all,
  e.g. a pi profile) is out of scope for the alias migration and never flagged.
- Stamps `schema_version: 2` once the file is otherwise migratable.
- Writes atomically (temp file + validate + rename), leaving the original byte-
  identical and loadable if anything goes wrong.
- Is idempotent — re-running it against an already-current file is a no-op.

Run it dry first to see the forecast without writing anything:

```bash
forge upgrade --dry-run       # per-file forecast: current / migratable /
                               # changed-if-applied / needs-human-decision /
                               # newer-unsupported — matches the real run file-
                               # for-file, and writes nothing
forge upgrade                 # migrates every safely-migratable file atomically,
                               # per file; leaves the rest unchanged
```

`forge upgrade` enumerates the host policy plus every project policy it has
discovered (see below) and reports a per-file outcome. It exits non-success
while any file still needs attention. `--json` carries a `modelPolicies` array
(one entry per discovered policy, with its `verdict`/`action`/`detail`) so a
script can act on the same per-file result the human summary prints — see
[Upgrading forge](how-to-upgrade.md) for the full `forge upgrade` contract.

**If a file lands on `needs-human-decision`:** open it, add the missing alias
entry (or its source) by hand, and re-run `forge upgrade` — it will pick the
now-resolvable file up on the next pass. **`unreachable`** means the recorded
checkout no longer resolves on this host (nothing to migrate until it does).
**`newer-unsupported`** means this forge binary is older than the policy's
`schema_version` — upgrade Forge itself, never the file.

### Discovery is historical and best-effort — never a fleet inventory

`forge upgrade` (and `forge doctor` / the setup surface, read-only) enumerate
the host policy plus every project Forge has a **durable evidence row** for —
drawn from prior runs, campaigns, and host verifications. This is explicitly
**not** a claim of fleet-wide completeness: a project forge has never
dispatched against is invisible to discovery, by design. Each project resolves
to one of four states:

| State | Meaning |
| --- | --- |
| `has-policy` | a reachable checkout with a `.forge/model-policy.yml` |
| `reachable-no-policy` | a reachable checkout with no policy file (legacy mode) |
| `unreachable-deleted` | evidence exists, but no recorded directory resolves now |
| `known-but-no-path` | a registered project with no path evidence at all |

Discovery never mutates or prunes anything it reads, and migration never
merges a host policy into a project's — project-over-host stays full-file
replacement, exactly as ordinary resolution does (see
[Turn it on](#turn-it-on) above).

`forge doctor` and the setup surface report host + discovered project policy
version/migration state **read-only**, and point at `forge upgrade` for
anything that needs it — they never migrate anything themselves.

## Profile-selection precedence (highest wins)

1. **CLI / run override** — `forge invoke <agent> --profile <name>` (one agent),
   or `forge new <workflow> --profile <name>` (pins **every** task in the run —
   primary, red, fanout).
2. `overrides.agents[role]`
3. `defaults.activity[capability]`
4. `defaults.profile`

The concrete model is then `profile.map[capability]` (falling back to
`map.default`); an unmapped capability with no `default` fails loud.

### `activity_unmapped` — an explicit activity that isn't mapped

Every resolution carries a **mapping-path** provenance axis, separate from
which profile was selected: `exact` (the capability hit `profile.map`
directly) or `default-fallback` (it fell through to `map.default`).

When a workflow step names an activity **explicitly** and that activity falls
through to `map.default` on a profile that otherwise maps named activities,
forge refuses the dispatch **before the container starts** — `activity_unmapped`
— rather than silently running the profile's default model for a capability
you asked for by name. A **role-derived** default-fallback (no explicit
activity was requested) stays valid, and a profile whose map is *only*
`default` (an intentional catch-all) is never flagged either way.

```bash
forge model resolve <agent> --activity <name> --project <dir> --json
```

reports the refusal machine-readably: the agent, the activity, the selected
profile, how the profile was selected (`resolvedBy` — a separate axis from
mapping-path), the mappings the profile DOES have, the `map.default` model
(labelled diagnostic-only — it is never what would have dispatched), and the
policy path. `forge show <task-id>` and the dashboard render the same
mapping-path axis on every resolved task, distinctly from `resolvedBy`, so a
default-fallback is never displayed as though it satisfied an explicit
activity. Fix it by adding the activity to the profile's map, or by dropping
the explicit `activity:` to accept the profile default.

## When a policy edit takes effect

Resolution is **per dispatch, from disk**: `resolveModel` re-reads
`model-policy.yml` every time a task is dispatched. There is no daemon and no
cached policy — so an edit takes effect on the **next task dispatched**, with no
restart, and tasks already in flight keep the profile they were dispatched with.
A task's resolution is recorded on the task itself (`manifest.json` +
`model.profile_resolved`), so what a past task ran on is history, never
recomputed from today's policy.

**Exception — `forge review-loop`'s reviewer is pinned per loop run (FG-513).**
The loop resolves its reviewer's profile **once, at loop start** (same precedence
as above) and reuses it for every round. Editing the policy while a loop is
running does **not** change that loop's reviewer between rounds; the edit lands on
the next loop run. This is deliberate: because resolution is otherwise
per-dispatch, a mid-loop edit used to move the reviewer onto a different profile
partway through — and when that profile was provider-broken, it structurally
killed an otherwise-passing run (the FG-502 incident). One loop run gets one
reviewer.

If a reviewer dispatch fails on **provider/model infrastructure**
(`failure_kind: model_error` — invalid model, quota, provider 4xx, broken provider
CLI), the loop retries it once, same round, on the default review path
(`defaults.activity.review ?? defaults.profile`), bypassing `overrides.agents`
— that override is what selected the broken profile. A profile you pinned with
`--review-profile` is never silently switched: the retry stays on it. The retry
is bounded at one — if it also fails, the loop stops (`reviewer_failed`). See
[Review-loop reviewer](concepts.md#review-loop-reviewer).

## Pin a whole run

```bash
forge new feature "ship X" --brief "..." --ticket FG-42 --profile claude-bedrock
```

Every task in the run resolves to `claude-bedrock`, recorded as
`resolvedBy: run.profile` (distinct from a single `forge invoke --profile`,
which records `cli.--profile`). The pin lives in run metadata and beats agent
overrides and activity defaults.

**`--meta` is not a backdoor.** The control-plane keys
`modelProfile` / `workspace` / `designDir` / `authProfile` are rejected from
`--meta` — set them only through their explicit flags (`--profile`,
`--workspace`, `--design-dir`, `--auth-profile`). They never leak into a task's
inputs or composed prompt.

## Choosing the interactive orchestrator

The same profile/precedence stack also selects **which interactive launcher runs** —
`forge orchestrator` and `forge claude` resolve the `orchestrator` agent role through this exact
mechanism, with no separate policy vocabulary. Point `overrides.agents.orchestrator` at a profile
whose runtime is `codex-subscription` to make Codex the default interactive session on this host or
project; see `docs/how-to-orchestrator-launcher.md` for the full launcher surface, the
capability/parity matrix versus Claude Code, and per-provider resume semantics.

## See and diagnose what resolved

```bash
forge model resolve <agent> --activity review --project <dir>   # dry-run: why this profile/model?
forge providers doctor                                          # which providers have working auth here?
forge show <task-id>                                            # the resolution record for a real task
```

In policy mode, `forge model resolve` also reports **`tool capable`** (whether
the policy entry sets `tool_capable`, and the inferred value for pi vs non-pi
runtimes) and **`dispatchable`** (whether the role can actually be dispatched to
this model). If `dispatchable: no`, the fix is shown inline.

Every policy-mode task writes provider + model + auth + `resolvedBy` (plus the
`capabilitySource` / `mappingPath` provenance axes described
[above](#activity_unmapped--an-explicit-activity-that-isnt-mapped)) into its
`manifest.json` and emits `model.profile_resolved` (or `model.profile_unavailable`
when a gate fails — activity-unmapped, availability, or tool-capability).

## Mixed-provider (Walk — shipped)

Two providers are live: **anthropic** (subscription/api/bedrock) and **openai**
(Codex via ChatGPT subscription). Routing is per-agent, so the SAME workflow YAML
runs across providers — the policy decides:

```yaml
overrides:
  agents:
    red-security: claude-bedrock      # anthropic
    red-wide: codex-subscription      # openai/Codex
```

Codex runs the `codex` CLI in a container (`codex exec --json`); its auth is the
host `~/.codex/auth.json` (`codex login` first — `forge providers doctor` shows
`openai/subscription` availability). Per-provider token usage is captured into
`model_calls` automatically. Today Codex is **subscription-only** (openai/api /
`codex-apikey` is not wired yet).

> The runtime seed `codex-subscription.yml` must be published into the seed
> generation dispatch reads for an openai profile to dispatch — since FG-583 that
> means `forge upgrade` (which republishes the atomic generation), not
> `install-seeds.sh` alone, which only refreshes the flat `~/.forge/runtimes/` copies.

## Pi and multi-provider runtimes — the `runtime:` profile field

Some runtimes front **many upstream providers** (groq, ollama, anthropic, …) so
the standard `(provider, auth) → runtime` binding table cannot uniquely select
them. Set the optional `runtime:` field on a profile to pin the runtime YAML
**directly**, then use `provider:` to name the upstream model vendor that
runtime should forward to.

> **#303 landed** — groq/api is now runnable. Set `GROQ_API_KEY` in the host env;
> `forge providers doctor` reports availability under the `groq/api` row; a
> dispatch fails loud before the container starts if the key is absent.
> Only providers in the API-key map (currently **anthropic** and **groq**) are
> wired for `auth.mode=apikey` injection — other vendors need a new row in
> `src/util/creds.ts:API_KEY_ENV_BY_PROVIDER` before they can dispatch. OpenAI
> api-key (`codex-apikey`) is intentionally absent from the map: its api probe
> returns `unknown`, so it would be injectable but doctor-invisible.

```yaml
model_profiles:
  # Requires GROQ_API_KEY in host env; `forge providers doctor` shows groq/api.
  pi-groq:
    provider: groq          # upstream vendor — threaded to the runtime as ${UPSTREAM_PROVIDER}
    runtime: pi-apikey      # explicit runtime YAML; skips the (provider, auth) binding table
    auth: api               # injects GROQ_API_KEY (resolved via the upstream provider)
    map:
      default: { model: moonshotai/kimi-k2-instruct, cost_tier: standard, tool_capable: true }
```

When `runtime:` is set on a profile:

- The resolver uses that runtime YAML **directly**, bypassing the
  `(provider, auth) → runtime` binding table.
- `provider:` becomes the **upstream vendor** — passed to the container as the
  `${UPSTREAM_PROVIDER}` template variable (e.g. pi receives `--provider groq`).
- Profiles **without** `runtime:` behave exactly as before — `(provider,
  effective auth)` selects the runtime from the binding table; `provider:` is
  the forge-level provider name used for binding, not an upstream hint.

The pi runtime seeds (`pi-apikey`, `pi-oauth`) fall back to `--provider
anthropic` when `${UPSTREAM_PROVIDER}` is empty — so a direct `forge invoke
--runtime pi-apikey` with no policy active keeps the existing anthropic-bound
behavior unchanged.

> **Provider names are not validated beyond presence.** Forge does not maintain
> a registry of valid upstream provider strings; an unknown or misspelled
> `provider:` value fails at runtime invocation, not at policy load. The
> `runtime:` name fails loud at dispatch time if the runtime YAML is not
> installed in `~/.forge/runtimes/`.

## Tool capability gate (FG-339)

Pi runtimes front arbitrary upstream models (Groq, Ollama, …) whose tool-calling
reliability is unknown. Forge enforces a **fail-fast capability gate at dispatch
time**: if the resolved role requires structured `result.json` output (engineer,
red-*, and similar structured roles) and the model is not confirmed tool-capable,
the task fails immediately with a clear message — before any container starts.

**Default policy by runtime:**

| Runtime | Default | Override |
|---|---|---|
| Anthropic (subscription / api / bedrock) | capable | no `tool_capable` field needed |
| OpenAI / Codex | capable | no `tool_capable` field needed |
| Pi (`pi-apikey`, `pi-oauth`) | **NOT capable** | set `tool_capable: true` on the capability entry |

Pi defaults to non-capable because its upstream is unknown at policy-load time.
Set `tool_capable: true` on each capability entry in a pi profile only after
confirming the model reliably calls tools:

```yaml
map:
  default: { model: moonshotai/kimi-k2-instruct, cost_tier: standard, tool_capable: true }
```

**Narrative roles are not affected.** Roles like `research-specialist`,
`research-primary`, `research-skeptic`, and `prompt-author` do not require
structured result.json output, so they pass the gate regardless of `tool_capable`.
FG-337's inferred-result fallback handles their completion.

**Diagnose before dispatch:**

```bash
forge model resolve <agent> --project <dir>   # shows tool_capable + dispatchable verdict
```

If `dispatchable: no`, add `tool_capable: true` to the relevant capability entry
or switch to a non-pi profile.

## Still future — Run (#225)

Bounded orchestrator *choice*: `allowed_profiles` as a ceiling + cost-tier
guardrails so the orchestrator can pick a profile within policy bounds rather
than only honoring fixed overrides.
