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

## Scope (Crawl)

Claude-only across bedrock/api/subscription. A second provider (Codex) and the
usage-parser hook land in **Walk (#224)**; bounded orchestrator choice
(`allowed_profiles`, cost-tier guardrails) lands in **Run (#225)**.
