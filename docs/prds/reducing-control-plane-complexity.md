# Reducing Forge Control-Plane Complexity

**Status:** concept / roadmap. This document has no implementation authority;
accepted work must be represented in the backlog and living plan.

Forge has accumulated several necessary policy layers: workflow YAML, runtime YAML,
model policy, RACI routing policy, project overrides, seeds, constraints, docs
surfaces, auth profiles, and host-global state. Each layer has a defensible job,
but the combined system is hard for a human to hold in memory.

The goal should not be to hide this complexity behind another vague abstraction.
The goal should be to make the effective system explain itself, with provenance,
before and after work runs.

## 1. Add `forge explain`

Add a command that renders the resolved control plane for a proposed run or an
existing run.

Examples:

```bash
forge explain --workflow feature --project ~/code/app --brief "add login"
forge explain run-add-login-abc123
```

It should answer:

- Which route was selected, and from which routing-policy source.
- Which workflow file is effective: host default or project override.
- Which model policy is effective.
- Which model profile each role or capability will use.
- Which runtime and auth mode each task will use.
- Which constraints apply, and which are skipped.
- Which project/design/task mounts will exist.
- Which gates and reds will run.
- Which docs surfaces are considered operator-facing.

This turns "remember every layer" into "ask Forge what reality is."

## 2. Add `forge config graph`

Add a command that shows active, ignored, generated, and seed-only config.

Example:

```bash
forge config graph --project .
```

Possible output:

```text
project
  .forge/model-policy.yml        overrides host model policy
  .forge/workflows/feature.yml   absent, using host workflow
  .forge/routing-policy.yml      absent, using host routing policy

host
  ~/.forge/model-policy.yml      active
  ~/.forge/workflows/feature.yml active
  ~/.forge/routing-policy.yml    active

repo seeds
  seeds/model-policy.example.yml template only, not active
```

This should explicitly label whether a file is `active`, `ignored`,
`derived`, `missing`, or `seed/template only`.

## 3. Avoid Vague Modes; Explain Concrete Model Policy

Do not add another broad abstraction like `personal-cheap`, `balanced`, or
`work-mode` yet. Those names create another thing to remember:

```text
What does personal-cheap mean again? Haiku? Free-tier model? Pi?
```

Instead, keep `model-policy.yml` as the real mechanism and make it easier to
read and explain.

Prefer concrete profile names that encode mechanism:

```yaml
model_profiles:
  anthropic-subscription-sonnet:
  anthropic-bedrock-sonnet:
  openai-subscription-codex:
  groq-api-qwen:
  pi-local-ollama:
```

Then add an explanation surface:

```bash
forge model explain
```

Example output:

```text
Role / capability      Profile                         Provider    Auth          Model
default                anthropic-subscription-sonnet   anthropic   subscription  claude-sonnet-...
architecture-advisor   anthropic-subscription-opus     anthropic   subscription  claude-opus-...
red-wide               anthropic-subscription-haiku    anthropic   subscription  claude-haiku-...
research-skeptic       openai-subscription-codex       openai      subscription  gpt-...
```

`forge setup model-policy` can still generate this file interactively, but it
should generate literal, concrete names rather than cute aliases. Add a
whole-system "mode" selector only later, and only if users repeatedly need to
switch between complete policy sets.

## 4. Make Precedence Rules Uniform

Standardize one rule everywhere possible:

```text
Project file fully replaces host file.
Host file fully replaces seed default.
Seeds are installation templates only.
```

If any subsystem uses merge semantics, it should be rare and explicitly named.
For example:

```yaml
merge: true
```

Project overrides should always be surfaced loudly because file-level
replacement is easy to forget.

## 5. Add "Why Did Forge Do That?" Receipts

Record decision provenance in the DB and task manifest for every major
control-plane decision.

Example manifest block:

```json
{
  "route": {
    "key": "implementation_quick",
    "source": "host",
    "responsible": "engineer",
    "resolved_by": "routing-policy.yml"
  },
  "workflow": {
    "name": "feature",
    "source": "host",
    "path": "~/.forge/workflows/feature.yml"
  },
  "constraints": [
    {
      "name": "atlas-stack-rn",
      "applied": false,
      "reason": "requires tag atlas"
    }
  ]
}
```

This lets `forge show`, the dashboard, and future reports explain not just what
happened, but why Forge chose that path.

## 6. Add A Control-Plane Dashboard View

Add a dashboard tab for the effective control plane.

It should show:

- Active host config.
- Project overrides.
- Installed agents.
- Installed workflows.
- Model profiles and auth availability.
- Runtime availability.
- Drift warnings.
- Recent RACI audit entries.
- Current orchestrator sessions.

The dashboard should be a cockpit for the system, not only a run viewer.

## 7. Turn `forge setup` Into A Guided Wizard

`forge setup` should become the human-facing entry point for control-plane
configuration.

It should ask concrete questions:

- Which providers are available?
- Which auth modes are available?
- Which model should be used for default work?
- Which model should be used for reasoning-heavy work?
- Which model should be used for red review?
- Should Codex or Pi be configured?

Then it should generate:

- `model-policy.yml`
- missing routing policy
- runtime readiness checks
- seed install or refresh
- dashboard readiness summary

The final output should summarize the effective setup in plain terms.

Example:

```text
Forge is configured as:
  default work:          anthropic-subscription-sonnet
  reasoning-heavy work:  anthropic-subscription-opus
  red review:            anthropic-subscription-haiku
  research skeptic:      openai-subscription-codex
```

## 8. Separate Source, Derived, And Effective Views

Use consistent vocabulary across commands and docs:

- `SOURCE`: what a human edits.
- `DERIVED`: what Forge compiled.
- `EFFECTIVE`: what will actually run after precedence and overrides.

Examples:

- RACI Markdown is source.
- `routing-policy.yml` is derived.
- The route selected for a prompt is effective.
- Workflow YAML is source.
- The expanded run plan is effective.
- `model-policy.yml` is source.
- Per-role model/runtime/auth resolution is effective.

This vocabulary gives humans a compression layer for reasoning about the
system.

## 9. Add A Short Invariants Document

Create a compact "Forge invariants" document. It should be short enough to
remember and strict enough to settle debates.

Candidate invariants:

```text
1. SQLite is the source of run/task truth.
2. Project overrides fully replace host config.
3. Seeds are templates, not active config.
4. Reds are read-only at the OS level.
5. Blue agents may write only through the project mount.
6. Runs complete when no top-level work remains, even if tasks failed.
7. Model policy chooses who runs; workflow YAML describes work.
8. Durable docs are maintained by documentation-maintainer.
9. Every major control-plane decision should be explainable after the fact.
```

These invariants should be referenced by `forge explain`, docs, and future
control-plane changes.

## 10. Add A Dashboard Backlog Viewer

If humans should rarely run CLI commands directly, backlog orientation should
not depend primarily on:

```bash
forge backlog notes show
forge backlog list --status active
forge backlog show FG-345
```

Add a dashboard backlog view that lets a human browse the project backlog and
session handoff state without asking the orchestrator to run CLI commands.

Read-only MVP:

- Show backlog notes / current handoff.
- List active epics, stories, and ideas.
- Filter by type and status.
- Open a ticket detail view with frontmatter and body.
- Show parent epic relationships when present.
- Link related runs/tasks when that relationship exists or becomes available.

Keep mutation out of the first version. Creating, editing, moving, and closing
tickets can remain orchestrator/CLI-driven until the read-only viewer proves the
shape.
