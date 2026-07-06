# How-to: add a new workflow

Workflows are YAML files loaded from `~/.forge/workflows/<name>.yml` (global) or `<project>/.forge/workflows/<name>.yml` (per-project override). Seeds live at `seeds/workflows/` and are installed by `install-seeds.sh`. Schema validation is handled by Zod in `src/v2/schema.ts`.

## Example: add a `security-audit` workflow

This example exercises three primitives that don't appear in the feature workflows in isolation and aren't shown in any existing seed:

- **`gate: verdict`** — the gate resolves from the reds panel automatically; there is no human stop unless the verdict fails or the human overrides.
- **Mixed-authority red panel** — `authority: authoritative` reds block the gate on fail; `authority: specialist` reds annotate without blocking. Both authorities can coexist on the same step.
- **`on_reject`** — when a human rejects a gate (overriding a verdict or a human stop), execution returns to a named upstream step rather than aborting the run.

The full seed is at `seeds/workflows/security-audit.yml`.

### Step 1: write the YAML file

Create `seeds/workflows/security-audit.yml`:

```yaml
name: security-audit
description: |
  Point-in-time security audit. An investigator surfaces findings; a
  mixed-authority red panel decides the gate — authoritative reds block on
  any fail, specialist reds annotate without blocking. A human reject on
  the audit step bounces back to investigation rather than aborting the run.

inputs:
  - name: scope
    required: true
    type: textarea
    help: "What to audit — repo paths, surface areas, threat model constraints, compliance frame."

steps:
  - id: investigate
    agent: security-advisor
    activity: spec-writer
    gate: human
    workflow_additions: |
      Survey the surfaces in inputs.scope. Document what you find as
      {surfaces_reviewed, findings: [{id, area, description, cwe, severity}],
      open_questions}. Classify, do not exploit.
    reds:
      - agent: red-security
        activity: fast-orchestrator
        authority: specialist
        gate_on_verdict: false

  - id: audit
    agent: security-advisor
    activity: default
    depends_on: [investigate]
    gate: verdict
    on_reject: investigate
    workflow_additions: |
      Given the investigation findings, produce a ranked audit report. For
      each finding confirm the threat model impact and assign a severity
      (critical / high / medium / low / informational). Output
      {report: markdown, critical_count, high_count, pass: boolean}.
    reds:
      - agent: red-security
        activity: fast-orchestrator
        authority: authoritative
        gate_on_verdict: true
      - agent: red-wide
        activity: fast-orchestrator
        authority: authoritative
        gate_on_verdict: true
      - agent: red-narrow
        activity: fast-orchestrator
        authority: specialist
        gate_on_verdict: false
```

### Step 2: understand `gate: verdict` and the reds panel

`gate: human` pauses and waits for `forge gate <task-id> advance`. `gate: verdict` resolves automatically from the reds panel — no human stop unless the verdict closes the gate (blocked) or the human chooses to intervene.

Two fields on each red determine its effect on the gate:

| field | value | effect on gate |
|---|---|---|
| `authority` | `authoritative` | red's verdict counts toward blocking the gate |
| `authority` | `specialist` | red's verdict is surfaced as annotation only |
| `gate_on_verdict` | `true` | a `fail` verdict from this red blocks advance |
| `gate_on_verdict` | `false` | verdict is recorded but does not block |

In the `audit` step: `red-security` and `red-wide` are `authority: authoritative, gate_on_verdict: true` — a fail from either blocks the gate and the task enters `blocked_by_red`. `red-narrow` is `authority: specialist, gate_on_verdict: false` — it can fail without blocking; its findings annotate the task view for the human to consider.

When blocked, the human can force-advance anyway: `forge gate <task-id> advance --force --rationale "..."`.

> **Schema constraint:** `gate: verdict` requires at least one red. A `verdict` step with an empty `reds` list is rejected at load time — nothing to aggregate.

### Step 3: understand `on_reject`

When a human rejects a gate step — either overriding a `verdict` result or explicitly declining a `human` gate — forge looks for `on_reject` on the step. If set, execution returns to that step; the named step re-runs with the same inputs plus the human's rejection rationale available in context. If `on_reject` is absent, a reject aborts the run.

In `security-audit`, rejecting the `audit` gate returns to `investigate`. The reviewer's rejection message tells the investigator where to dig deeper — a different surface, a missed dependency — without starting a new run from scratch.

`on_reject` must name an existing step id. The loader validates this; a typo is a schema error at load time, not a silent runtime no-op. It cannot target a `fanout` step: recovery into a fanout has no defined re-expansion/child-identity semantics, so the schema rejects such a workflow at load time (FG-478).

### Step 4: ensure the agent dirs exist

`agent: security-advisor` resolves to `~/.forge/agents/security-advisor/`. That directory must contain a `CLAUDE.md` (the agent's base prompt). If you are referencing a new role, see `how-to-new-agent.md`.

> **Step field vocabulary (#227).** `activity:` names a *capability intent* (e.g. `review`, `reasoning`, or a legacy alias like `spec-writer`) — resolved against `defaults.activity` / the profile map (policy mode) or `runtime.models[alias]` (legacy mode). The old field name `model:` is a **deprecated alias** (still accepted, warns once). Do **not** set `runtime:` on new workflows: it is a legacy-only escape hatch consulted only when no `model-policy.yml` is active; under a policy the runtime is derived from the resolved provider and auth, and the field is ignored.

### Step 5: install and test

```bash
# Install seeds (copies to ~/.forge/workflows/)
./install-seeds.sh

# Validate the YAML parses correctly
npx tsx -e "import('./src/v2/loader.js').then(m => m.loadWorkflow('security-audit', { projectDir: process.cwd() })).then(w => console.log(JSON.stringify(w, null, 2)))"
```

### Step 6: invoke

```bash
forge new security-audit "atlas-auth-audit" --scope "Audit OAuth token handling in src/auth/ and src/middleware/"
forge next run-atlas-auth-audit-<suffix> --project ~/code/atlas
```

## Fanout with discipline-based agent routing

If a step fans out (one upstream-array element per child) and you want different agents per child based on a per-input field, declare `agent_map` on the `fanout:` block. The canonical example is `feature.yml`'s build step:

```yaml
- id: build
  agent: engineer                    # fallback for unmapped disciplines
  depends_on: [plan]
  gate: verdict
  fanout:
    from_upstream:
      step: plan
      array_key: steps
      input_key: step
    agent_map:
      frontend: frontend-specialist
      backend: backend-specialist
      infosec: security-advisor
      platform: agentic-platform-builder
    max_concurrency: 4
    failure_mode: fail-phase
  reds:
    # ... reds attach to the parent, run once on the aggregate diff
```

Each plan-step (`{id, summary, files, acceptance, discipline}`) becomes one child task. The runner reads `step.discipline` (or whatever you set `discipline_key` to) and looks it up in `agent_map`. Hits route to the mapped agent; misses fall back to `step.agent`. Inputs that aren't objects (or where the discipline_key field is missing/non-string) also fall back.

The upstream agent (here, `tech-lead`) must emit the discipline field on each element. See `seeds/agents/tech-lead/CLAUDE.md` for the output-schema example.

**Reds on fanout:** reds always attach to the parent fanout step and run once after children settle — there is no per-child red dispatch. This matches the cost tradeoff for the `feature` build (5 children × 5 reds would be 25 containers per build); if a workflow ever needs per-child reds, that would be a separate schema change.

## Notes

- Each step can carry `workflow_additions` — phase-specific framing appended to the agent's base `CLAUDE.md`.
- A step can have `gate: "human" | "verdict" | "auto" | "none"` — see `docs/concepts.md`.
- `gate: verdict` requires at least one red (enforced by the schema). All `authority: authoritative, gate_on_verdict: true` reds must pass for the gate to advance.
- `on_reject: <step-id>` routes a rejected gate back to a named upstream step instead of aborting. The target must be an existing step id and must not be a `fanout` step (rejected at load time — see Step 3).
- Steps declare dependencies via `depends_on: [step-id, ...]`. The runner dispatches in topological order; the schema rejects cycles.
- A step can be `manual: true` — no agent runs, the human submits artifacts via `forge submit`. Manual steps must have `gate: human`, no reds, and no fanout. See `feature-ui-design-needed.yml` for an example.
