# How-to: add a new workflow

Workflows are TypeScript files under `src/workflows/`. There is no YAML, no JSON, no separate loader. The `Workflow` type in `src/types/index.ts` is the schema; autocomplete on phase names and agent references from day one.

## Example: add a `code-review` workflow

Two phases: `review` (a panel of assessors fans out) and `report` (a reporter aggregates).

### Step 1: register the workflow name

In `src/types/index.ts`, add the new name to `WorkflowName`:

```ts
export type WorkflowName =
  | "feature-design-provided"
  | "feature-design-needed"
  | "investigation"
  | "codebase-assessment"
  | "code-review";
```

In `src/spine/workflows.ts`, add it to `VALID_NAMES`. The CLI's `forge new` validation reads from the same source.

### Step 2: write the workflow file

Create `src/workflows/code-review.ts`:

```ts
import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

export const workflow: Workflow = {
  name: "code-review",
  description: "Multi-lens code review with adversarial cross-check.",
  phases: [
    {
      name: "review",
      agents: [agent("assessor", "spec-writer")],
      reds: {
        wide: agent("red-wide", "fast-orchestrator"),
        parallel: true,
        authority: "specialist",
        gateOnVerdict: false,
      },
      fanout: { maxConcurrency: 4, failureMode: "continue" },
      gate: "human",
      workflowAdditions:
        "For each lens, output {lens, findings: [{severity, summary, evidence, recommendation}]}.",
    },
    {
      name: "report",
      agents: [agent("reporter", "spec-writer")],
      gate: "auto",
      workflowAdditions:
        "Aggregate per-lens findings into a single prioritized report. Output {report: markdown}.",
    },
  ],
};
```

### Step 3: ensure the agent dirs exist

`agent("assessor", ...)` resolves to `~/.forge/agents/assessor/`. That directory must contain a `CLAUDE.md` (the agent's base prompt) and a `settings.json`. The seeds repo already includes `assessor`, `red-wide`, and `reporter`. If you reference a new role, see `how-to-new-agent.md`.

### Step 4: test without a full run

Typecheck the workflow file:

```bash
npm run typecheck
```

Then dry-run the loader:

```bash
node --import tsx -e "import('./src/spine/workflows.js').then(m => m.loadWorkflow('code-review')).then(console.log)"
```

You should see your phases printed.

### Step 5: invoke

```bash
forge new code-review "atlas-clock-skew-review" --meta '{"lenses":["security","performance"]}'
forge next run-atlas-clock-skew-review-<suffix> --project ~/code/atlas
```

## Notes

- Each phase can carry `workflowAdditions` (Tier 2 of `composeSystemPrompt`) — phase-specific framing appended to the agent's base CLAUDE.md.
- A phase can have `gate: "human" | "verdict" | "auto"` — see `docs/concepts.md`.
- For mid-pipeline branching, set `phase.onReject = "<other-phase-name>"`. On `forge gate <task> reject`, forge creates tasks for the alternate phase as children of the rejected task.
