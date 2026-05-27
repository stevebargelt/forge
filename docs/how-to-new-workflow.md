# How-to: add a new workflow

Workflows are YAML files loaded from `~/.forge/workflows/<name>.yml` (global) or `<project>/.forge/workflows/<name>.yml` (per-project override). Seeds live at `seeds/workflows/` and are installed by `install-seeds.sh`. Schema validation is handled by Zod in `src/v2/schema.ts`.

## Example: add a `code-review` workflow

Two steps: `review` (a panel of assessors fans out) and `report` (a reporter aggregates).

### Step 1: write the YAML file

Create `seeds/workflows/code-review.yml`:

```yaml
name: code-review
description: Multi-lens code review with adversarial cross-check.

inputs:
  - name: brief
    required: true
    type: text
    help: "What to review and any specific focus areas."

steps:
  - id: review
    agent: assessor
    model: spec-writer
    gate: human
    workflow_additions: |
      For each lens, output {lens, findings: [{severity, summary, evidence, recommendation}]}.
    fanout:
      from_upstream:
        step: null
        array_key: lenses
        input_key: lens
      max_concurrency: 4
      failure_mode: continue
    reds:
      - agent: red-wide
        model: fast-orchestrator
        authority: specialist
        gate_on_verdict: false

  - id: report
    agent: reporter
    model: default
    depends_on: [review]
    gate: auto
    workflow_additions: |
      Aggregate per-lens findings into a single prioritized report. Output {report: markdown}.
```

### Step 2: ensure the agent dirs exist

`agent: assessor` resolves to `~/.forge/agents/assessor/`. That directory must contain a `CLAUDE.md` (the agent's base prompt). If you reference a new role, see `how-to-new-agent.md`.

### Step 3: install and test

```bash
# Install seeds (copies to ~/.forge/workflows/)
./install-seeds.sh

# Validate the YAML parses correctly
npx tsx -e "import('./src/v2/loader.js').then(m => m.loadWorkflow('code-review', { projectDir: process.cwd() })).then(w => console.log(JSON.stringify(w, null, 2)))"
```

### Step 4: invoke

```bash
forge new code-review "atlas-clock-skew-review" --brief "Review the clock-skew handling in src/sync/"
forge next run-atlas-clock-skew-review-<suffix> --project ~/code/atlas
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

**Reds on fanout:** today reds always attach to the parent fanout step and run once after children settle — there's no per-child red dispatch. This matches the cost tradeoff for the `feature` build (5 children × 5 reds would be 25 containers per build); if a workflow ever needs per-child reds, that'd be a separate schema change.

## Notes

- Each step can carry `workflow_additions` — phase-specific framing appended to the agent's base CLAUDE.md.
- A step can have `gate: "human" | "verdict" | "auto" | "none"` — see `docs/concepts.md`.
- Steps declare dependencies via `depends_on: [step-id, ...]`. The runner dispatches in topological order.
