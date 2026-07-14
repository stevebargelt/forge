---
id: FG-554
type: story
status: active
title: "forge claude: resolve the interactive orchestrator model from model policy instead of inheriting Claude Code's default"
created: 2026-07-13
---

## Problem

`forge claude` does not currently select the interactive orchestrator's model.
It creates an orchestrator run/task, adds the project display name, and passes
the remaining user arguments directly to `claude`. Unless the operator supplied
`--model`, the final command contains no model:

```text
forge claude --dangerously-skip-permissions
  -> claude -n <project-name> --dangerously-skip-permissions
```

The orchestrator therefore inherits whatever model Claude Code selects as its
current default. That selection is outside Forge's model policy, can change
when Claude Code or the account default changes, and is discovered only after
the session from transcript usage.

Observed 2026-07-13 in the host-global Forge database: `claude-fable-5` had
4,054 recorded calls across 14 orchestrator tasks/runs, and zero non-orchestrator
tasks. None of those orchestrator task rows recorded a pre-launch
`agent_model`, `resolved_profile`, `resolved_provider`, `resolved_auth`, or
`resolved_by`. The `model_calls.alias = orchestrator` value is post-hoc usage
attribution, not evidence that Forge selected the model.

This contradicts the operator's intended control-plane contract: Forge owns
model selection for Forge work. Containerized agents already resolve a profile
and concrete model through the host/project `model-policy.yml` stack and pass
that model explicitly. The interactive orchestrator is currently the exception
despite being the highest-leverage and longest-running Forge role.

Source evidence: `src/cli/commands/claude.ts` builds
`finalArgs = ["-n", resolvedName, ...passthrough]` and spawns `claude` without
calling the model-policy resolver. The same file creates the orchestrator task
without resolution fields, then later extracts actual usage with
`alias: "orchestrator"` after Claude exits.

## Goal

When `forge claude` starts a new interactive orchestrator session without an
explicit model override, Forge resolves the desired Claude model from the
effective host/project model policy (or a deliberately-defined
orchestrator-specific derivative), passes the concrete model to Claude, records
the resolution before launch, and shows it to the operator.

No interactive orchestrator should silently inherit a changing Claude Code
default.

## Design Questions

- **Policy shape.** Decide whether `orchestrator` becomes a normal agent-role
  override in the existing resolver, receives a named default activity such as
  `reasoning`, or uses an explicit `orchestrator:` section derived from the same
  profile maps. Do not create an unrelated second model-policy system.
- **`forge claude` is provider-specific.** The command launches Claude Code.
  If effective policy resolves `orchestrator` to Codex, Pi, or another
  non-Claude runtime, fail clearly before spawn or define a separate generic
  orchestrator command. Do not silently ignore the policy or launch the wrong
  provider. Cross-provider interactive orchestration is not required by this
  story.
- **Auth/profile coherence.** Reconcile model-policy selection with the
  existing OAuth/API-key/Bedrock selection performed by `forge claude`,
  including project auth config and explicit `--bedrock` / `--aws-profile`.
  The selected model must be valid for the auth/runtime actually launched.
- **Explicit override precedence.** Preserve the operator's ability to pass
  `--model`. Define whether it is a concrete-model override or policy alias,
  make its precedence unambiguous, validate it against the selected Claude
  runtime where possible, and record `resolved_by` as a CLI override.
- **Resume semantics.** Decide and test `--continue` and `--resume`. Applying
  today's policy to an old session may intentionally upgrade the model or may
  silently change the identity of resumed work. The behavior must be explicit
  and visible rather than accidental.
- **Policy availability/failure.** Decide the fail-closed behavior for missing,
  invalid, incompatible, or unavailable orchestrator policy. Falling back to
  Claude Code's implicit default recreates the defect and is not acceptable.

## Acceptance Criteria

- `forge claude` without `--model` resolves an orchestrator profile and concrete
  Claude model from the effective host/project policy and passes an explicit
  `--model <concrete-model>` to the spawned Claude CLI.
- The resolution honors documented host/project precedence and uses the shared
  model-policy parser/resolver rather than a hand-written parallel mapping.
- An explicit CLI model override has documented highest precedence, reaches the
  spawned command exactly once, and is recorded as an explicit override.
- A policy result incompatible with `forge claude`'s provider, runtime, or auth
  mode fails before spawning Claude with an actionable message. It never falls
  back silently to Claude Code's default.
- Before spawn, the orchestrator task records the selected concrete model,
  profile, provider, auth mode, and resolution source. The dashboard/`forge
  show` can therefore explain the selection while the session is running; it
  does not have to wait for transcript extraction.
- The launch banner names the effective model and profile/auth source so the
  operator can see what will run before the first prompt.
- Post-session `model_calls` remain bound to the orchestrator task and agree
  with the pre-launch selection. A mismatch is surfaced as evidence rather
  than silently rewriting the recorded selection.
- OAuth, API-key, and Bedrock orchestrator launches each have argv/resolution
  coverage. Existing credential preflight behavior remains intact.
- New-session, `--continue`, and explicit `--resume` behavior are each defined
  and covered by tests, including the chosen model-drift behavior for resumed
  sessions.
- Documentation for `forge claude` and model policy explains the orchestrator
  selection rule, override precedence, failure behavior, and how to inspect the
  effective choice.

## Out Of Scope

- Changing model selection for containerized agents; they already use the
  explicit policy-resolution path.
- Making `forge claude` launch Codex, Pi, or arbitrary future providers.
- Retrofitting historical orchestrator task rows with inferred selections.
- Treating the post-hoc `model_calls.alias` field as the model-selection
  contract.

