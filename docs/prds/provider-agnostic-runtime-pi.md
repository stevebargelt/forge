# PRD - Provider-Agnostic Runtime Architecture and Pi Pilot

**Status:** accepted for backlog planning; implementation not started
**Captured:** 2026-06-04
**Backlog reconciled:** 2026-06-05 (#258, #262, #265, #291, #292)
**Related backlog:** #258, #260-#268, #291, #292, #253, #252, #225, #220, #224, #226, #228
**Primary spike:** `docs/prds/pi-258/spike-259-pi-json-event-schema.md`

## Objective

Move Forge toward a provider-agnostic runtime architecture by separating:

- **Runtime mechanics** - how an agent process is launched, prompted, logged,
  authenticated, and parsed.
- **Upstream provider/model choice** - which model vendor, endpoint, auth mode,
  and concrete model satisfy a requested capability.

Pi (`pi.dev`, npm `@earendil-works/pi-coding-agent`) is the pilot candidate for
this architecture because it can front many upstream providers and local models
through one headless runtime. Claude Code and Codex should remain supported
runtimes during the transition, but they should no longer define Forge's
provider architecture.

This is not merely "add Pi as a third runtime." The strategic goal is to make
Forge's runtime layer honest enough that Pi could become the default
provider-agnostic runtime where it works, while Claude Code and Codex remain
compatibility or escape-hatch runtimes where they provide unique value.

## Problem

Forge has made real progress toward multi-provider execution:

- Runtime YAML owns process execution.
- `model-policy.yml` owns capability/profile/model selection.
- Codex proved that a non-Claude CLI can run inside the agent container.
- Usage capture already has provider-specific parser logic.

But the current model still conflates concepts that Pi makes impossible to
ignore:

- `provider` is overloaded. It can mean the CLI/runtime Forge launches
  (`codex`, `claude-code`) or the upstream model vendor (`openai`,
  `anthropic`, `groq`, `ollama`).
- Usage parsing is currently selected by model provider. That breaks for Pi,
  because Pi can emit Pi JSONL while running Anthropic, OpenAI, Groq, Cerebras,
  local Ollama, or another upstream provider.
- Prompt/context injection is runtime-specific, but the current seams are still
  shaped by Claude Code and Codex.
- Auth is partly runtime-specific and partly upstream-provider-specific.
- Adding Pi as a one-off special case would deepen the ambiguity instead of
  resolving it.

If Forge wants to be genuinely provider agnostic, the runtime layer must name
these distinctions explicitly.

## Core Decision

Forge should route execution through a **runtime implementation** and route
model choice through an **upstream provider/profile**.

Example policy vocabulary:

> **Draft vocabulary — not implemented as shown.** This block is a conceptual sketch that combines runtime-execution fields and model-selection fields into a unified shape that was never implemented literally. What shipped:
> - **Runtime execution metadata (#292)** lives on the runtime YAML as: `runtime_kind`, `log_format`, `prompt_strategy`, `auth_strategy`. Note: the shipped Pi values differ from this draft — `prompt_strategy` is `message-arg` (not `stdin-prepend`) and `auth_strategy` is `env-provider-api-key` (not `provider_env`).
> - **Upstream provider + model selection (#265)** lives on the model-policy profile as `provider:` (the upstream vendor) + optional `runtime:` (explicit runtime YAML name) + the capability `map:`. There is no literal `upstream_provider:` field on the runtime YAML, and `model:` is not a runtime YAML field for provider selection.

```yaml
# draft vocabulary — see note above
runtime: pi
log_format: pi-jsonl
prompt_strategy: stdin-prepend
auth_strategy: provider_env
upstream_provider: groq
model: llama-3.3-70b-versatile
```

Existing runtimes become instances of the same shape:

```yaml
# draft vocabulary — see note above
runtime: claude-code
log_format: claude-stream-json
prompt_strategy: claude-stdin-package
auth_strategy: oauth-volume
upstream_provider: anthropic
model: claude-sonnet-4-6
```

```yaml
# draft vocabulary — see note above
runtime: codex
log_format: codex-jsonl
prompt_strategy: stdin-prepend
auth_strategy: codex-auth
upstream_provider: openai
model: gpt-5-codex
```

Pi then becomes the pilot for this architecture, not just another provider
entry.

## Vocabulary

### Runtime

The executable agent loop Forge launches in a container.

Examples:

- `claude-code`
- `codex`
- `pi`

Runtime owns:

- command and arguments
- stdin/stdout contract
- result file contract
- prompt/context injection strategy
- credential mounting/env wiring mechanics
- log/event format
- idle timeout and container behavior

### Upstream Provider

The model vendor or endpoint used by the runtime.

Examples:

- `anthropic`
- `openai`
- `groq`
- `cerebras`
- `google`
- `mistral`
- `ollama`
- `lm-studio`
- `vllm`

Upstream provider owns:

- model namespace
- API key or OAuth/provider credential expectations
- provider availability checks
- provider-specific error causes
- provider-reported usage/cost fields, if any

### Log Format

The event stream shape Forge parses for completion, usage, errors, and
diagnostics.

Examples:

- `claude-stream-json`
- `codex-jsonl`
- `pi-jsonl`

Usage capture must dispatch by `log_format`, not by upstream provider.

### Prompt Strategy

How Forge injects the composed system prompt and task package into the runtime.

Examples:

- `stdin-prepend`
- `generated-system-file`
- `runtime-context-file`

Prompt strategy must guarantee the Forge system prompt, constraints, and
`result.json` contract are delivered exactly once.

### Auth Strategy

How credentials reach the runtime.

Examples:

- `env-provider-api-key`
- `oauth-volume`
- `codex-auth`
- `pi-auth-json`
- `local-endpoint`

Auth strategy should make secret flow explicit and should fail loud when a
required credential is unavailable.

## Proposed Runtime Metadata

Runtime YAML should grow explicit metadata fields, or an equivalent typed shape,
so Forge does not infer behavior from provider names:

```yaml
name: pi-apikey
runtime: pi
log_format: pi-jsonl
prompt_strategy: stdin-prepend
auth_strategy: env-provider-api-key

image: agent-dev-worker:latest

invocation:
  command: pi
  args:
    - -p
    - "${TASK_PACKAGE_MARKDOWN}"
    - --mode
    - json
    - --no-context-files
    - --provider
    - "${UPSTREAM_PROVIDER}"
    - --model
    - "${MODEL}"

result:
  file: /task/result.json
  stdout_log: container.stdout.log
  stderr_log: container.stderr.log
```

Open implementation detail: whether `runtime` and `log_format` are top-level
runtime YAML fields, nested under `capabilities`, or inferred from a typed
runtime kind. The non-negotiable requirement is that usage parsing and prompt
strategy are selected by runtime/log metadata, not by upstream provider.

## Model Policy Shape

Model policy should distinguish the runtime used to execute a model from the
upstream provider/model selected for the task.

Illustrative shape:

> **#265 shipped vocabulary:** the profile field is `provider:` + optional `runtime:`, not `upstream_provider:`.
> `upstream_provider:` was the PRD draft name and was never implemented.

```yaml
model_profiles:
  pi-groq-cheap-reds:
    runtime: pi-apikey
    provider: groq
    auth: api
    map:
      review:  { model: llama-3.3-70b-versatile, cost_tier: cheap }
      fast:    { model: llama-3.1-8b-instant, cost_tier: cheap }
      default: { model: llama-3.3-70b-versatile, cost_tier: cheap }

  pi-ollama-local:
    runtime: pi-local
    provider: ollama
    auth: local
    map:
      review:  { model: qwen2.5-coder:32b, cost_tier: free }
      default: { model: qwen2.5-coder:32b, cost_tier: free }

  claude-subscription:
    runtime: claude-oauth
    provider: anthropic
    auth: subscription
    map:
      reasoning: { model: claude-opus-4-8, cost_tier: premium }
      review:    { model: claude-sonnet-4-6, cost_tier: standard }
      default:   { model: claude-sonnet-4-6, cost_tier: standard }
```

This preserves current provider/profile behavior while removing the assumption
that provider directly implies runtime.

## Usage and Cost Policy

### MVP

Store token usage only, consistent with Forge's existing `model_calls` posture.
Pi's parser should map:

- `usage.input` -> fresh input tokens
- `usage.output` -> output tokens
- `usage.cacheRead` -> cache read tokens
- `usage.cacheWrite` -> cache creation/write tokens
- `messages[].model` and `messages[].provider` -> runtime-reported model and
  upstream provider metadata where Forge has a place to preserve it

Do not write Pi's precomputed dollar cost into Forge's legacy `cost` column.
Forge intentionally treats dollar conversion as unstable across OAuth,
subscription, Bedrock, cache tiers, and changing price tables.

### Follow-On

If Pi's provider-reported cost proves useful, add an explicit nullable field
such as `provider_reported_cost_usd`, with clear labeling that it is
runtime/provider-reported telemetry, not Forge-computed billing truth.

## Pi Pilot Scope

### Crawl

Goal: one Pi-backed Forge task completes end to end with correct runtime
mechanics.

Required:

1. Add Pi to the agent image.
2. Add a minimal Pi runtime YAML using API-key auth.
3. Add explicit runtime/log-format metadata sufficient to dispatch the correct
   usage parser.
4. Add `pi-jsonl` usage parser using the spike mapping.
5. Capture one live Pi JSONL stream before parser acceptance is considered
   complete.
6. Resolve prompt injection so Forge's system prompt and result contract are
   delivered exactly once.
7. Complete one real Forge role through Pi.

Exit criterion: a task goes `dispatch -> Pi -> result.json -> usage captured ->
gate` with output-schema parity against Claude Code/Codex tasks.

### Walk

Goal: Pi becomes selectable through model policy for bounded use.

Required:

1. Model-policy profiles can select `runtime: pi-*` plus an upstream provider.
2. Unknown provider/model aliases fail loud.
3. Provider API-key availability is visible in provider doctor or equivalent
   auth diagnostics.
4. Pi error events map to Forge `model_error` rather than generic container
   crashes.
5. At least one cheap red/triage role is routed through Pi.

### Run

Goal: Pi can serve as Forge's default provider-agnostic runtime where it proves
reliable.

Possible:

1. OAuth via pre-seeded `~/.pi/agent/auth.json`.
2. Local models through Pi `models.json`.
3. Runtime fallback policy: prefer Pi for certain capabilities, fall back to
   Claude Code or Codex where Pi lacks capability or auth.
4. Broader provider availability matrix.
5. Provider adapter docs generated from the same runtime/profile truth.

## Relationship to Existing Work

### #258

Reframe #258 from:

> Integrate Pi as a third agent runtime.

to:

> Build provider-agnostic runtime architecture, with Pi as the pilot/default
> candidate.

The current #260-#268 story list mostly survives, but several stories need
tighter language.

### #262

Change "provider-keyed usage parser" to "runtime/log-format-keyed usage
parser." This is the most important architectural correction. Pi can run many
upstream providers, so upstream provider cannot select the parser.

Also move live event-stream capture into acceptance. The #259 spike used
published TypeScript types, which is valid for schema discovery, but parser
acceptance needs at least one real stream.

### #265

Expand from "model-policy integration + alias mapping" to "runtime plus upstream
provider selection." Model policy should resolve:

- capability
- runtime
- upstream provider
- auth mode
- concrete model

### #263

Keep as high-risk. Prompt injection is the primary runtime-specific unknown.
The invariant is "Forge context exactly once." The implementation can be
`stdin-prepend`, generated `.pi/SYSTEM.md`, or another strategy, but it must be
explicit and testable.

### #253

Provider adapter surfaces become downstream renderings of runtime/profile
truth. Claude-specific files should not decide runtime policy. They should
explain or invoke Forge-owned primitives.

### #273

Routing policy chooses the work path. Model policy chooses capability/profile.
Runtime policy executes the selected profile. These are related but distinct
control surfaces.

## Provider-Specific Features Forge Actually Uses

The case for Pi is stronger because Forge already treats Claude Code and Codex
mostly as headless agent loops inside Forge-owned orchestration, not as complete
interactive products.

Forge owns or is moving toward owning:

- workflow fanout and dependency progression
- gates and human escalation
- result contracts (`result.json`)
- retry and repair behavior
- review routing and red/green semantics
- container sandboxing and read-only project mounts
- ops attention signals
- provider-adapter rendering

So several features Pi does not include by default are not major Forge losses:

- **Permission popups.** Forge already bypasses Claude/Codex permission systems
  in agent containers. The container boundary and project mount mode are the
  safety layer.
- **Plan mode.** Forge routes planning/spec work through explicit agents and
  workflows rather than relying on a runtime-native plan mode.
- **Subagents.** Forge owns fanout through workflows, `forge invoke`, and the
  blackboard. Runtime-native subagents would be redundant and harder to observe.
- **To-dos.** Forge tracks durable work in tasks, events, gates, and backlog
  entries. Runtime-local to-do state is not authoritative.
- **Background bash.** Forge already runs agents in containers with stdout/stderr
  capture and idle watchdogs. Long-running process management should stay in
  Forge/container machinery.

The provider-specific features that do matter today are narrower:

### Browser Tools / Skills

Browser tooling is the main skill-like dependency Forge uses heavily. However,
it is not inherently Claude-native. Forge's browser-tools capability came from
the Pi ecosystem (`pi-skills/browser-tools`) and is currently delivered through
Claude Code's skill path because Claude is today's dominant runtime surface.

That means browser-tools is a compatibility and packaging task, not a reason to
keep Claude Code as the architectural center.

Questions to settle in the Pi pilot:

- Can Pi load the same browser-tools capability directly as a Pi skill/package?
- Does the existing `~/pi-skills/browser-tools` layout work for Pi, or does it
  need a Pi package/resource manifest?
- Does Forge's auth preloading patch for browser-tools still work when invoked
  by Pi rather than Claude Code?
- Should browser control eventually become a Forge-owned primitive that any
  runtime can invoke, instead of an agent-runtime skill?

### MCP / Pencil / Design Tooling

MCP-heavy roles, especially Pencil/design work, may still require a
Claude-compatible runtime until Forge has an adapter. Pi's core does not include
MCP by default; it expects that behavior to be built or installed as an
extension/package.

This is acceptable for the Pi pilot. Pi does not need to replace every runtime
on day one. It should first prove cheap reds, triage, and ordinary coding-agent
tasks.

### Auth Formats

Forge already has working Claude OAuth volume and Codex auth-file handling. Pi
uses its own API-key/OAuth/config model, so auth is real migration work.

Crawl should use provider API keys because that path is easiest to reason about.
OAuth through Pi belongs in Walk/Run after the runtime seam works.

### Runtime Logs and Usage

Claude Code, Codex, and Pi emit different event streams. This is not a reason to
avoid Pi; it is the reason Forge needs `log_format` as an explicit runtime
field. Usage parsing must follow runtime/log format, not upstream provider.

### Model Tool-Calling Quality

Pi can front many providers and local models, but not all upstream models will
perform equally well as coding agents. Local/open models may be useful for cheap
triage or narrow reds but unreliable for complex implementation. Forge should
evaluate Pi by role and capability, not assume provider breadth equals quality.

## What We Lose / What We Do Not Lose

### Real Losses Or Risks

- Native Claude Code/Codex product affordances where Forge has not built an
  equivalent.
- Native MCP availability for design/tooling roles until adapted.
- Existing Claude/Codex auth paths as the default credential story.
- Provider-native agent-loop tuning for Anthropic/OpenAI models.
- Simplicity of provider-keyed usage parsing.

### Not Material Losses For Forge

- Permission prompts, because Forge uses container isolation.
- Runtime-native plan mode, because Forge routes planning through workflows and
  agents.
- Runtime-native subagents, because Forge owns fanout and blackboard state.
- Runtime-native to-dos, because Forge owns durable task/backlog state.
- Background bash, because Forge owns container execution and observability.
- Browser-tools as a Claude dependency, because the capability came from the Pi
  ecosystem and can be repackaged or made runtime-neutral.

The strategic trade is therefore acceptable: Forge gives up some vendor-native
agent product affordances in exchange for runtime/provider neutrality. Because
Forge already owns most orchestration semantics, that trade is smaller than it
would be for a human using Claude Code or Codex directly.

## Risks

### Pi May Not Be Stable Enough as Default Runtime

Mitigation: pilot Pi as an opt-in runtime first. Do not remove Claude Code or
Codex support until Pi proves reliability on real Forge tasks.

### Runtime Abstraction Could Become Too Abstract Too Early

Mitigation: add only the fields Pi forces: runtime, log format, prompt strategy,
auth strategy, upstream provider. Avoid a broad runtime framework until one Pi
task works end to end.

### Cost Telemetry Could Reopen a Settled Design

Mitigation: tokens-only MVP. If provider-reported cost is added, make it
explicitly nullable and provider-reported.

### Prompt Injection Could Double-Load Context

Mitigation: test with `--no-context-files`; inspect whether Pi loads
`.pi/SYSTEM.md`, `AGENTS.md`, or `CLAUDE.md`; make the prompt strategy explicit
in runtime metadata.

### Auth Could Become Fragmented

Mitigation: keep Crawl to env-var API-key mode. OAuth and local auth are Walk/Run
items behind provider-doctor/auth-seam work.

## Non-Goals

- Dropping Claude Code or Codex immediately.
- Making Pi the mandatory runtime before it proves reliability.
- Building native integrations for every Pi upstream provider.
- Adding a Forge price table for Pi providers.
- Solving provider adapter generation in this PRD.
- Replacing workflow YAML or routing policy.

## Open Questions

1. Should runtime YAML name `runtime` as `pi`, `claude-code`, `codex`, or should
   it name a narrower `runtime_kind`?
2. Should `log_format`, `prompt_strategy`, and `auth_strategy` be required for
   every runtime YAML, or defaulted for legacy runtime files?
3. Should model policy profiles point directly to a runtime YAML name, or to a
   higher-level runtime capability?
4. Where should Forge preserve Pi's runtime-reported upstream provider/model
   when a run switches models mid-run?
5. Is `provider_reported_cost_usd` worth adding later, or should Forge keep
   cost entirely outside the DB?
6. Does Pi's `--no-context-files` suppress `.pi/SYSTEM.md`, `AGENTS.md`, and
   `CLAUDE.md`, or only project context files?
7. Which role is the right first end-to-end Pi task: cheap red, triage, or a
   constrained documentation task?

## Backlog Reconciliation

Applied 2026-06-05:

- Renamed #258 to "Provider-agnostic runtime architecture, with Pi as the
  pilot/default candidate."
- Added #292 as the pre-Pi runtime-metadata seam: runtime kind, log format,
  prompt strategy, and auth strategy must be explicit before Pi is wired as a
  binary/runtime.
- Amended #262 to dispatch usage parsing by `log_format`, not provider.
- Amended #262 acceptance to require one live Pi JSONL capture before parser
  lands.
- Amended #265 to separate runtime selection from upstream provider/model
  selection.
- Added #291 to make the Pi runtime PRD one of the first commitments in the
  stable, feature-rich Forge baseline.

Still open:

- Keep #260, #261, #263, #264, #266, #267, and #268 mostly intact unless the
  first implementation pass proves they should be split.

## Success Criteria

The PRD succeeds when Forge can run at least one real task through Pi while:

- model policy selects both runtime and upstream provider explicitly
- usage capture dispatches by log format
- the parser records token usage without relying on provider name
- prompt/context is injected exactly once
- task output and gate behavior match existing Claude Code/Codex tasks
- Claude Code and Codex continue to work as compatibility runtimes

Longer term, this succeeds if Forge can treat Pi as the default runtime for
cheap reds, triage, and local-model work without changing workflow YAML.
