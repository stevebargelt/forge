---
id: FG-576
type: story
status: active
title: Provider-neutral interactive orchestrator launcher resolves Claude or Codex from model policy
created: 2026-07-16
---

**Related:** FG-554 (`forge claude` model selection), FG-560 (model-policy schema/version migration),
FG-163 (interactive-orchestrator usage capture), FG-563 (durable interactive-orchestrator continuation).

## Problem

Forge can select Claude, Codex, or Pi runtimes for containerized task agents through the effective
host/project `model-policy.yml`, but it cannot make the same provider choice for the interactive session
that controls those agents.

The only first-class interactive launcher is `forge claude`. It supplies Claude-specific naming,
preflight, project-root, heartbeat, instruction, resume, and usage behavior and then launches the `claude`
CLI. FG-554 will make that command resolve an explicit Claude model from model policy, but deliberately
remains provider-specific: if policy selects Codex or Pi, it may refuse clearly, but it does not launch
them.

An operator can run `codex` manually and tell it to drive Forge, but that is not equivalent to a Forge
orchestrator. It does not automatically receive or durably record the effective orchestrator
profile/model/provider/auth decision, the Forge orchestrator identity and heartbeat, provider-appropriate
instruction/skill surfaces, project preflight, session-resume policy, or usage linkage. The result is a
manual shadow path whose behavior cannot be explained from Forge policy.

The operator wants Codex to be a supported interactive Forge orchestrator choice, selected from model
policy when no explicit launcher override is supplied.

## Goal

Add a provider-neutral interactive launcher (working name: `forge orchestrator`) that resolves the
orchestrator profile through the existing effective model-policy stack and dispatches the matching
interactive adapter. At minimum, Claude Code and Codex CLI are supported launch targets.

```text
forge orchestrator
  -> effective host/project model policy
  -> orchestrator profile
  -> runtime/provider/model/auth resolution
  -> claude adapter OR codex adapter
  -> one truthful orchestrator receipt + heartbeat
```

If the operator supplies no explicit profile/runtime/model override, policy decides. If the selected
runtime is unsupported, Forge fails before spawn with an actionable explanation; it never silently
substitutes Claude, Codex, or an ambient CLI default.

## Routing and risk classification

This is a **control-plane, provider/auth, instruction-loading, and session-lifecycle trust boundary** with
machine-wide operator consequences. Route it as `implementation_full` with targeted security review of
argument construction, environment/auth isolation, instruction provenance, and receipt truthfulness. A
clear plan or small launcher diff must not downgrade it to `implementation_quick`.

## Required design decisions

- **Policy shape and precedence.** Reuse the shared model-policy parser/resolver. Define an orchestrator
  role/activity or deliberately derived section; do not create a second unrelated policy system. Define
  explicit precedence among CLI `--profile` / provider or runtime / concrete-model overrides, project
  policy, host policy, and Forge defaults.
- **Command surface.** Decide whether `forge claude` becomes an explicit provider shortcut around the
  shared launcher or remains separate while using the same resolution/receipt primitive. Existing scripts
  and aliases must not silently change provider.
- **Provider adapters.** Claude and Codex have different CLI flags, authentication, instruction files,
  skills, hooks, resume identifiers, permission modes, usage evidence, and lifecycle capabilities. Define
  a provider-neutral orchestrator contract and an explicit capability/parity matrix. Do not manufacture
  parity where a provider cannot supply it.
- **Codex instruction provenance.** Decide how the canonical Forge orchestrator policy reaches Codex
  (`AGENTS.md`, a generated/provider adapter, plugin/skill, explicit initial instructions, or another
  reviewed mechanism). It must derive from Forge's canonical policy source and update deterministically;
  a one-off pasted prompt is not the shipped adapter.
- **Heartbeat and ownership.** A Codex-launched orchestrator must appear in the same durable Forge
  orchestrator registry with an honest provider/runtime identity and crash/staleness behavior. Do not
  infer liveness from a process name alone.
- **Auth coherence.** Resolve and validate the credentials required by the selected adapter only. Claude
  OAuth/API-key/Bedrock preflight must not be applied to Codex, and Codex auth must not be treated as
  evidence that Claude can launch.
- **Resume semantics.** Define new session, continue, and explicit resume behavior for each provider,
  including whether policy changes may change the model of resumed work. Never resume a Claude session in
  Codex or vice versa by accident.
- **Usage and receipts.** Before spawn, durably record the resolved profile, runtime, provider, concrete
  model, auth mode, project/workspace, resolution source, adapter, and requested session operation. Bind
  post-session usage to that receipt where the provider exposes authoritative evidence; surface mismatch
  rather than rewriting history.
- **Failure policy.** Missing/invalid policy, unsupported runtime, unavailable CLI, incompatible model,
  failed auth, or missing required adapter surfaces fail clearly before an interactive session is
  represented as a live Forge orchestrator. No fallback to an ambient CLI default.
- **Init/upgrade propagation.** Define how provider-specific instruction, skill/plugin, hook, and project
  surfaces are installed and upgraded without hand-editing generated blocks or overwriting unrelated user
  configuration.

## Acceptance Criteria

- `forge orchestrator` with no provider/model override resolves an orchestrator profile from the effective
  project-over-host model policy and launches the runtime named by that resolution.
- A Claude-resolving profile launches Claude Code with an explicit, compatible concrete model and the
  correct Claude auth mode. A Codex-resolving profile launches Codex CLI with an explicit, compatible
  model/profile configuration. Neither adapter can silently launch the other provider.
- The operator can select Codex as the default interactive orchestrator through model policy without
  changing Forge source, shell aliases, generated prompts, or every project independently.
- Explicit CLI overrides have documented highest precedence, are validated against the selected adapter,
  reach the child argv/config exactly once, and are recorded with an explicit `resolved_by` value.
- An unsupported policy runtime (including Pi until/unless a Pi interactive adapter is deliberately
  shipped) fails before spawn and names the selected profile/runtime plus supported remediation.
- Claude and Codex both start in the resolved project root, carry the project display identity, pass
  provider-specific readiness checks, and create a durable running orchestrator receipt before the first
  prompt.
- Claude and Codex orchestrators both maintain an honest Forge heartbeat/liveness record containing the
  provider/runtime identity. Crash recovery and stale-session classification are tested; absence of a
  provider hook must not be reported as healthy liveness.
- The Codex adapter receives the canonical Forge orchestrator operating policy through a deterministic,
  upgradeable provider surface. A regression proves that running bare Codex without that surface is not
  falsely registered as a fully initialized Forge orchestrator.
- Provider-specific capabilities are documented and tested: instruction source, skills/commands,
  permission mode, auth, new/continue/resume, heartbeat, usage capture, and shutdown. Any unsupported
  capability is named rather than silently omitted.
- New session, continue, and explicit resume are covered for both adapters, including refusal of a
  cross-provider session identifier and the chosen model-drift behavior when policy changes.
- `forge show`, dashboard/operator surfaces, and the orchestrator registry can explain while the session
  is running which profile/runtime/provider/model/auth/adapter was selected and why.
- Post-session usage remains bound to the same orchestrator receipt. Where Codex cannot provide equivalent
  usage evidence, that limitation is explicit and no values are fabricated.
- Tests use fake/provider test CLIs and disposable configuration roots; they never start a billed
  interactive session, mutate real auth, or overwrite the operator's installed Claude/Codex settings.
- Existing `forge claude` behavior remains available as the explicit Claude path, or its replacement is
  accompanied by a tested compatibility/migration story. Existing aliases do not unexpectedly begin
  launching Codex merely because policy changes.
- Documentation explains the generic launcher, policy selection, explicit provider shortcut/override,
  failure behavior, resume behavior, capability differences, and how to inspect the effective choice
  before launch.

## Non-goals

- Changing containerized task-agent model selection; that already uses model policy.
- Pretending Claude-specific slash commands/hooks are natively supported by Codex.
- Silently translating arbitrary Claude CLI arguments into guessed Codex equivalents.
- Making Pi a supported interactive orchestrator without an explicit adapter and acceptance evidence.
- Replacing FG-563's durable completion/continuation work. This launcher must consume that contract when
  available rather than inventing a provider-specific monitoring mechanism.
- Retrofitting historical orchestrator rows with inferred provider/model selections.

## Relationship to FG-554

FG-554 remains the bounded correction for provider-specific `forge claude`: it makes Claude model
selection explicit and policy-driven. FG-576 owns the provider-neutral choice and Codex adapter. Planning
must identify shared resolver/receipt work once and prevent the two tickets from growing competing
orchestrator-policy implementations.
