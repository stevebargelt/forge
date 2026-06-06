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
on_unavailable: fail            # fail loud if the resolved auth isn't available
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription          # subscription | api | bedrock | auto
    map:
      reasoning: { model: claude-opus-4-8,   cost_tier: premium }
      review:    { model: claude-sonnet-4-6, cost_tier: standard }
      default:   { model: claude-sonnet-4-6, cost_tier: standard }
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
overrides:
  agents:
    red-security: claude-bedrock # this role always runs on bedrock
```

`auth: auto` resolves to whatever the environment offers
(`CLAUDE_CODE_USE_BEDROCK` → bedrock, `ANTHROPIC_API_KEY` → api, else
subscription); a *pinned* auth (`bedrock`/`api`/`subscription`) fails loud if
unavailable rather than silently switching.

## Profile-selection precedence (highest wins)

1. **CLI / run override** — `forge invoke <agent> --profile <name>` (one agent),
   or `forge new <workflow> --profile <name>` (pins **every** task in the run —
   primary, red, fanout).
2. `overrides.agents[role]`
3. `defaults.activity[capability]`
4. `defaults.profile`

The concrete model is then `profile.map[capability]` (falling back to
`map.default`); an unmapped capability with no `default` fails loud.

## Pin a whole run

```bash
forge new feature "ship X" --brief "..." --profile claude-bedrock
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

## See and diagnose what resolved

```bash
forge model resolve <agent> --activity review --project <dir>   # dry-run: why this profile/model?
forge providers doctor                                          # which providers have working auth here?
forge show <task-id>                                            # the resolution record for a real task
```

Every policy-mode task writes provider + model + auth + `resolvedBy` into its
`manifest.json` and emits `model.profile_resolved` (or
`model.profile_unavailable` when the gate fails).

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

> The runtime seed `codex-subscription.yml` must be installed (`install-seeds.sh`)
> into `~/.forge/runtimes/` for an openai profile to dispatch.

## Pi and multi-provider runtimes — the `runtime:` profile field

Some runtimes front **many upstream providers** (groq, ollama, anthropic, …) so
the standard `(provider, auth) → runtime` binding table cannot uniquely select
them. Set the optional `runtime:` field on a profile to pin the runtime YAML
**directly**, then use `provider:` to name the upstream model vendor that
runtime should forward to.

> **Non-anthropic upstream providers are NOT runnable today.** The example
> below (`provider: groq`) is **illustrative** — do not use it in a real policy
> file. Two pieces are missing and both are tracked in **#303**:
> 1. `forge providers doctor` has no probe for non-anthropic/openai providers,
>    so it cannot verify or report a GROQ_API_KEY (or any third-party key).
> 2. The pi-apikey runtime injects only `ANTHROPIC_API_KEY`; there is no
>    per-provider key-injection path yet.
> Until #303 lands, pi runs must use an anthropic upstream: `pi-apikey`
> (ANTHROPIC_API_KEY) or `pi-oauth` (Claude subscription). The `runtime:` field
> and `provider:` vocabulary described here **did ship in #265** and work
> correctly for anthropic; the gap is key injection + doctor visibility for other
> vendors.

```yaml
model_profiles:
  # ILLUSTRATIVE — not runnable until #303. See caveat above.
  pi-groq:
    provider: groq          # upstream vendor — threaded to the runtime as ${UPSTREAM_PROVIDER}
    runtime: pi-apikey      # explicit runtime YAML; skips the (provider, auth) binding table
    auth: api               # pi-apikey injects ANTHROPIC_API_KEY only; groq key injection is #303
    map:
      default: { model: moonshotai/kimi-k2-instruct, cost_tier: standard }
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

## Still future — Run (#225)

Bounded orchestrator *choice*: `allowed_profiles` as a ceiling + cost-tier
guardrails so the orchestrator can pick a profile within policy bounds rather
than only honoring fixed overrides.
