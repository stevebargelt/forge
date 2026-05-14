# forge v2 — agent directory schema

Each agent lives at `~/.forge/agents/<role>/`. The directory contains exactly
two files (today's shape, kept verbatim under v2):

```
~/.forge/agents/<role>/
├── CLAUDE.md       # The system prompt for this role.
└── settings.json   # Tool allowlist + metadata.
```

No code, no YAML, no per-agent runtime overrides. The agent is just a prompt
plus a permission scope.

## `CLAUDE.md`

The role's system prompt. Plain markdown. Composed at spawn time as:

```
<contents of CLAUDE.md>

<workflow_additions from the step that's invoking this agent>

<filtered constraints from ~/.forge/constraints/ matching this role/workflow/phase>

## Output contract
Write a single JSON object to /task/result.json with at minimum the fields
{"status": "complete"|"failed", ...role-specific output}. For red agents,
the role-specific output must match the Verdict schema.
```

The composition logic survives the v2 rewrite verbatim (it's in
`src/spine/composeSystemPrompt.ts` today — moves into the v2 runner unchanged).

## `settings.json`

A tiny JSON document declaring this role's tool allowlist + free-text notes.

```json
{
  "tools": ["read", "bash"],
  "notes": "Architect reads project files; produces structured output."
}
```

| field | type | meaning |
|---|---|---|
| `tools` | list of strings | Tool names from the claude CLI's `--tools` set. Common: `read`, `bash`, `edit`, `write`. Reds are typically `["read"]`. |
| `notes` | string | Free-text for humans. Not enforced. |

The runner reads `tools:` and adds `--tools <comma-joined>` to the claude CLI
invocation at spawn time. Today's spine does this; v2 keeps the same surface.

## Project-level agent overrides

A project can override a workspace-level agent by placing its own
`<project>/.forge/agents/<role>/CLAUDE.md` (and optionally `settings.json`).
The runner's resolution order:

1. `<project>/.forge/agents/<role>/CLAUDE.md` (if present, full replacement)
2. `~/.forge/agents/<role>/CLAUDE.md`

**Full replacement.** No merge semantics — a project that overrides `architect`
replaces it entirely. Same shape as the workflow override semantics.

## Where the seeds live in the repo

Today: `seeds/agents/<role>/` in the forge repo. The install script
(`scripts/install-seeds.sh`) copies these into `~/.forge/agents/` on first
install. `FORCE=1 scripts/install-seeds.sh` overwrites.

v2 keeps this layout exactly. No structural change needed to the install.

## What this doesn't include

- **Per-agent model selection** — model is declared at the workflow step
  (`step.model:`), not in the agent dir. Same agent can run under different
  models in different workflows.
- **Per-agent runtime selection** — same; runtime is workflow-level (or
  workspace-default via `runtimes:` map in the runtime YAML's pre-flight
  detection chain).
- **Per-agent env vars** — runtime YAML carries env vars; agents don't.
- **Discipline tagging** — today's `AgentRef.discipline` (used by specialist
  reds + specialist implementers, #96 sub-shift 1+2) becomes a *step-level*
  field in v2 (`step.discipline: frontend`), not an agent-dir property. Same
  generic `red-frontend` seed; routed-to-by-step rather than
  declared-on-itself.

## Translation status

Today's agents (15+ in `seeds/agents/`) ship unchanged under v2:
- architect, planner, implementer, verifier (core feature workflow)
- frontend-implementer, backend-implementer, infosec-implementer (specialists)
- red-wide, red-narrow, red-frontend, red-backend, red-security (reds)
- prompt-author (ui-design workflows)
- framer (investigation + codebase-assessment scoping)
- investigator, synthesizer, recommender (investigation fanout)
- assessor, reporter (codebase-assessment fanout)

No agent CLAUDE.md needs to change for the v2 cutover. Their *invocation* moves
from TS-spine to YAML-runner; their *prompts* don't.
