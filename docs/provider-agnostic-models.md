# Provider-Agnostic Models

> **Superseded (graduated) 2026-05-30** by
> `learnings/decisions/2026-05-30_provider-resolution.md`. Kept as provenance for
> the accepted decision; not a live spec.

Forge should become provider-agnostic without making workflows provider-specific.
The goal is not "add Codex" as a one-off. The goal is to let Forge resolve the
right model/provider for a task from policy, capabilities, availability, and user
preference.

Core invariant:

```text
Workflows describe work. Policies choose models. Drivers execute providers.
```

## Goals

1. Forge can choose stronger defaults for certain activities.

   Example: Forge may decide Codex/GPT-5.5 is the default for design-heavy
   frontend agents, while Claude remains the default for review or long-context
   synthesis.

2. End users can override Forge defaults.

   Example: a user may decide all red/review agents should use Codex, or that
   only `red-security` should use Claude Bedrock.

3. Users with only one provider can still use Forge.

   A user with only Codex or only Claude should be able to map every activity to
   their available provider without editing workflow definitions.

4. Forge or the orchestrator can request a model class, but not go rogue.

   Agents should not directly pick arbitrary expensive models. They can request
   capabilities or quality level; Forge resolves that request against an approved
   policy.

5. Bedrock, API keys, and subscription CLIs all fit the same model.

   These are transport/auth modes under a profile, not separate workflow types.

## Concept Separation

Keep these concepts distinct:

- **Agent role**: `designer`, `test-engineer`, `red-security`, `tech-lead`.
- **Task activity**: `design`, `implementation`, `review`, `red`, `qa`,
  `planning`, `synthesis`.
- **Model profile**: a named profile such as `codex-design-high` or
  `claude-review-bedrock`.
- **Provider driver**: execution implementation such as `claude-cli`,
  `codex-cli`, `anthropic-api`, `openai-api`, or `bedrock`.
- **Credential/auth mode**: subscription login, API key, Bedrock IAM/STS, etc.

Forge should resolve:

```text
task + role + activity + user policy + available providers
  -> model profile
  -> provider driver
  -> runtime/container invocation
```

Forge should not resolve:

```text
agent -> hardcoded claude command
```

## Model Policy Shape

Introduce model profiles and model policy. This can live globally, with project
overrides:

- Global: `~/.forge/model-policy.yml`
- Project: `<project>/.forge/model-policy.yml`

Example:

```yaml
model_profiles:
  codex-design:
    driver: codex-cli
    provider: openai
    model: gpt-5.5
    auth: codex-subscription
    capabilities: [code, design, vision, browser]
    cost_tier: high

  claude-review:
    driver: claude-cli
    provider: anthropic
    model: claude-sonnet
    auth: claude-subscription
    capabilities: [code, review, long_context]
    cost_tier: medium

  claude-bedrock-review:
    driver: bedrock
    provider: anthropic
    model: us.anthropic.claude-sonnet
    auth: aws-sts
    capabilities: [code, review, long_context]
    cost_tier: medium

defaults:
  activity:
    design: codex-design
    review: claude-review
    red: claude-review
    implementation: claude-review
    qa: claude-review

overrides:
  agents:
    red-security: claude-bedrock-review
    red-backend: codex-design

allowed_profiles:
  - codex-design
  - claude-review
  - claude-bedrock-review
```

Workflow steps should describe the work:

```yaml
steps:
  - id: security-review
    agent: red-security
    activity: red
```

They should not need to hardcode provider transport:

```yaml
# Avoid making workflow logic provider-specific.
model: claude-sonnet
runtime: claude-bedrock
```

Provider-specific details belong in policy and model profiles.

## Resolution Order

Model resolution should be deterministic and explainable.

Recommended precedence:

1. CLI override:

   ```bash
   forge invoke red-security --model-profile codex-review
   ```

2. Project policy:

   ```text
   <project>/.forge/model-policy.yml
   ```

3. Workflow step:

   ```yaml
   model_profile: claude-review
   activity: red
   ```

4. Agent default metadata.

5. Forge default policy.

6. Available fallback, only when explicitly allowed.

Every resolved task should write the decision into `manifest.json`:

```json
{
  "model": {
    "profile": "codex-design",
    "provider": "openai",
    "driver": "codex-cli",
    "model": "gpt-5.5",
    "resolvedBy": "project.overrides.agents.red-security"
  }
}
```

`forge show` should display the same resolution so users can answer:

```text
Why did this task use this model?
```

Add a diagnostic command:

```bash
forge model resolve red-security --activity red --project /path/to/app
```

Output should explain the selected profile, fallbacks considered, and any
provider availability failures.

## Orchestrator Choice

The orchestrator should not choose arbitrary providers or model IDs directly.

Bad:

```json
{
  "provider": "openai",
  "model": "most-expensive-model"
}
```

Better:

```json
{
  "requested_capabilities": ["vision", "frontend_design"],
  "quality": "high",
  "latency": "normal"
}
```

Forge then resolves that request against:

- `allowed_profiles`
- max cost tier
- project/user policy
- available credentials
- task capability requirements
- fallback policy

This lets the orchestrator express intent while Forge enforces budget and safety.

## Provider Drivers

Add a provider-driver abstraction underneath model profiles.

Sketch:

```ts
interface ModelDriver {
  id: string;
  checkAvailable(profile: ModelProfile): Availability;
  buildContainerArgs(ctx: SpawnContext, profile: ModelProfile): DockerArgs;
  parseResult(ctx: TaskRuntimeContext): AgentResult;
}
```

Initial drivers:

- `claude-cli`
- `codex-cli`

Later drivers:

- `anthropic-api`
- `openai-api`
- `bedrock`

The driver owns provider-specific invocation details. Workflow and orchestration
code should operate on resolved profiles, not provider-specific command strings.

## Auth And Transport Modes

Treat Bedrock, API keys, and subscriptions as auth/transport modes inside a
profile.

Examples:

```yaml
model_profiles:
  claude-subscription-review:
    driver: claude-cli
    provider: anthropic
    model: claude-sonnet
    auth: claude-subscription

  claude-api-review:
    driver: anthropic-api
    provider: anthropic
    model: claude-sonnet
    auth: anthropic-api-key

  claude-bedrock-review:
    driver: bedrock
    provider: anthropic
    model: us.anthropic.claude-sonnet
    auth: aws-sts

  codex-subscription-design:
    driver: codex-cli
    provider: openai
    model: gpt-5.5
    auth: codex-subscription

  openai-api-design:
    driver: openai-api
    provider: openai
    model: gpt-5.5
    auth: openai-api-key
```

Tradeoffs:

- **Subscription CLI**: easiest for users who already pay for Claude/Codex, but
  local login state can be fragile and telemetry is less clean.
- **API key**: portable, automation-friendly, and better for usage accounting.
- **Bedrock/IAM**: enterprise-friendly and strong for credential isolation, but
  more configuration-heavy.
- **OAuth/browser subscription**: convenient, but should be backed by good
  `doctor` checks and clear failure messages.

## Fallbacks

Fallbacks should be explicit.

Example:

```yaml
fallbacks:
  enabled: true
  strategy: same_capability_lower_cost
  max_cost_tier: medium
  allowed_profiles:
    - claude-review
    - codex-review
```

Do not silently substitute models if that changes task semantics.

When fallback happens, write it to the task manifest and lifecycle events:

```json
{
  "event": "model.fallback_applied",
  "payload": {
    "requestedProfile": "codex-design",
    "selectedProfile": "claude-review",
    "reason": "codex-cli unavailable"
  }
}
```

## Options

### Option A: Runtime YAML Only

Add more runtime YAMLs:

```text
claude-oauth.yml
claude-bedrock.yml
codex-subscription.yml
codex-api.yml
```

Workflow steps point directly to runtimes.

Pros:

- Fastest implementation.
- Reuses current runtime machinery.
- Minimal schema change.

Cons:

- Provider choice leaks into workflows.
- Overrides become awkward.
- Harder to support users with only one provider.
- Harder to explain fallback decisions.

This can be a bridge, but should not be the final shape.

### Option B: Model Profiles + Driver Interface

Add model profiles, policy resolution, and provider drivers.

Pros:

- Clean separation between work and provider.
- Supports Forge defaults, user overrides, single-provider users, and approved
  orchestrator choice.
- Gives `forge show` and manifests a clean explanation story.
- Lets Bedrock/API/subscription share one conceptual model.

Cons:

- More upfront design.
- Requires a resolver and a driver abstraction.
- Needs migration from current runtime naming.

This is the recommended durable path.

### Option C: Full Model Broker

Forge runs a local broker that handles routing, credentials, budgets, retries,
usage accounting, telemetry, and provider APIs.

Pros:

- Powerful long-term control plane.
- Best place for adaptive routing and budget enforcement.
- Strongest observability story.

Cons:

- Overbuilt for the first provider-agnostic implementation.
- More operational surface area.
- Easy to turn into a second platform before Forge needs it.

This may be useful later, but should not be the first implementation.

## Recommended Plan

### Crawl

Objective: support multiple providers without destabilizing existing Claude
workflows.

Deliverables:

- Add `model_profiles` schema.
- Preserve current Claude behavior as the default profile.
- Add `claude-cli` and `codex-cli` drivers.
- Add model resolution with deterministic precedence.
- Add per-agent and per-activity overrides.
- Add `forge model resolve`.
- Add `forge providers doctor`.
- Record resolved model profile/provider/driver in `manifest.json`.
- Surface resolved profile in `forge show`.

Acceptance criteria:

- Existing workflows run unchanged.
- A user can map all activities to Claude.
- A user can map all activities to Codex.
- A user can override only `red-*` agents to Codex.
- Manifests explain why each task used its profile.
- No orchestrator can select a profile outside `allowed_profiles`.

### Walk

Objective: make model choice ergonomic and policy-driven.

Deliverables:

- Add activity defaults: `design`, `implementation`, `review`, `red`, `qa`,
  `planning`, `synthesis`.
- Add capability metadata and compatibility checks.
- Add explicit fallback policy.
- Add provider availability checks before dispatch.
- Add lifecycle events:
  - `model.profile_resolved`
  - `model.profile_unavailable`
  - `model.fallback_applied`
- Add project-local `.forge/model-policy.yml`.
- Add global policy merge behavior.

Acceptance criteria:

- Forge can explain profile resolution from CLI/project/workflow/default.
- Provider unavailable errors fail fast with actionable messages.
- Fallbacks happen only when policy allows them.
- Users can keep provider preferences out of workflow YAML.

### Run

Objective: support advanced routing, cost controls, and adaptive model choice.

Deliverables:

- Add API drivers:
  - `anthropic-api`
  - `openai-api`
  - `bedrock`
- Add cost tiers and budget caps.
- Add rate-limit and quota awareness.
- Let orchestrator request capability/quality instead of provider/model.
- Add historical quality metrics by activity/profile.
- Add constrained adaptive routing:
  - only inside `allowed_profiles`
  - only inside `max_cost_tier`
  - always recorded in manifest/events

Acceptance criteria:

- Forge can route by capabilities and policy.
- Orchestrator requests are constrained by approved profiles.
- Cost and provider decisions are observable.
- Historical metrics can inform future defaults.

## Design Rules

- Workflows should not be provider-specific.
- Agents should not directly choose arbitrary model IDs.
- Forge should always record the resolved profile and why it was selected.
- Fallbacks must be explicit and observable.
- Subscription, API, and Bedrock should be modeled as auth/transport choices
  under profiles.
- Existing Claude workflows must continue to work without policy files.
- Single-provider users must have a first-class path.

## Open Questions

- Should `activity` be required on every step, inferred from agent role, or both?
- Should project policy be allowed to define new profiles, or only select from
  global/admin-defined profiles?
- How strict should `allowed_profiles` be by default?
- Should `forge model resolve` run provider availability checks by default, or
  only explain static policy unless `--check` is passed?
- Should cost tiers be qualitative (`low`, `medium`, `high`) first, or numeric
  budgets from the beginning?
- How much should runtime YAML remain visible after model profiles exist?

## Recommended First Cut

Build Option B, but keep the Crawl scope small:

1. Define `model_profiles`.
2. Implement deterministic model resolution.
3. Keep current Claude as the default profile.
4. Add `codex-cli` as a second CLI driver.
5. Add per-agent and per-activity overrides.
6. Add manifest/show visibility.
7. Add `forge model resolve`.
8. Add provider doctor checks.

Do not start with a broker. Do not let workflows become a matrix of provider
runtimes. Keep the provider abstraction under policy, not in the orchestration
logic.
