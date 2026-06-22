# Decision: Workflow definitions are TypeScript files (not YAML/JSON)

**ID**: FORGE-DEC-004
**Date**: 2026-05-06
**Status**: Decided (resolves open question #1 from the spine sketch)
**Decided by**: Spine sketch (2026-05-06)
**Supersedes**: N/A
**Scope**: forge

---

## Context

A workflow needs a place where its phases, agents, gate types, and red configs are defined. The spine sketch's open question #1 listed YAML, JSON, and TypeScript as candidates and resolved on TypeScript. This ADR captures the reasoning so the choice doesn't get re-litigated when someone reaches for a YAML parser by reflex.

---

## Problem

**What format should workflow definitions use?**

---

## Options Considered

### Option A: YAML

**Pros**:
- Conventional in CI / orchestration tooling
- Human-editable

**Cons**:
- Needs a YAML parser dependency
- Type-checking the result requires writing a separate runtime validator (zod, ajv, etc.)
- No autocomplete on phase or agent role names — typos surface as runtime errors
- Phase names are referenced in multiple places (workflow file, gate calls, constraint frontmatter); YAML can't statically check that they line up

---

### Option B: JSON

Same as YAML, even less ergonomic.

---

### Option C: TypeScript (export a `Workflow` object) ✅

```ts
import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

export const workflow: Workflow = {
  name: "investigation",
  phases: [/* ... */],
};
```

**Pros**:
- The `Workflow` type IS the schema — no separate validator
- IDE autocomplete on phase names, agent roles, gate types
- TypeScript catches structural errors at typecheck time
- Workflow files can share helpers (`agent("framer", "spec-writer")`) without templating
- Loading is one `import` + a runtime sanity check; no parser needed

**Cons**:
- Workflows are now "code" in the sense that someone editing one needs `npm run typecheck` to catch errors
- Slightly higher activation energy than editing YAML

---

## Decision

**Chose**: Option C — TypeScript

**Rationale**: The workflow definition shape is the most error-prone surface in forge — phase names appear in many places (the workflow file itself, gate calls, constraint frontmatter, agent dirs). Static typing closes that error class entirely. The "workflow definition loader" line item in the spine sketch's build table collapses to `await import(file)` and a runtime check that the export is the right shape.

The "but YAML is more accessible" argument doesn't apply here — forge is a personal CLI for someone who already lives in TypeScript daily.

---

## Consequences

**Positive**:
- Adding a new workflow is: write `src/workflows/<name>.ts`, add the name to `WorkflowName` and `VALID_NAMES`, run `npm run typecheck`
- The schema can evolve without ad-hoc migration logic — TypeScript flags every workflow file that no longer compiles

**Negative / Trade-offs**:
- Editing a workflow requires Node + tsx; can't be done on a system without TypeScript tooling

---

## Implementation Notes

- Each `src/workflows/<name>.ts` exports `export const workflow: Workflow = { ... }`
- `src/v2/loader.ts` `loadWorkflow(name)` does a dynamic `import()` + a structural check (`name` matches, `phases` is an array)
- `_agentRefs.ts` exports a small `agent(role, model)` helper so workflow files don't duplicate the `~/.forge/agents/<role>` path computation
- Adding a new workflow name requires touching three places: `WorkflowName` (types), `VALID_NAMES` (workflows.ts), and the new file. By design — it's small enough to be obvious

---

## Revisit Conditions

- If forge ever needs to support workflows authored by people who don't write TypeScript (a paid-product scenario, not a personal-tool scenario)
- If hot-reload of workflow definitions becomes important during a long-running process
