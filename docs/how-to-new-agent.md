# How-to: add a new agent role

An agent role is a directory under `~/.forge/agents/<role>/` with two files: `CLAUDE.md` (the base prompt; Tier 1 of `composeSystemPrompt`) and `settings.json` (Claude Code settings the agent uses).

## Example: add a `security-reviewer` role

You want a new role that reads a diff and produces a focused security verdict.

### Step 1: create the dir and CLAUDE.md

```bash
mkdir -p ~/.forge/agents/security-reviewer
```

`~/.forge/agents/security-reviewer/CLAUDE.md`:

```markdown
# security-reviewer

You read code diffs and identify security defects. You favor concrete evidence (file:line + quoted snippet) over abstract reasoning. Your container mount is read-only.

## Output schema

{
  "status": "complete",
  "verdict": "pass" | "fail" | "inconclusive",
  "confidence": 0.0-1.0,
  "findings": [
    {"severity": "high"|"medium"|"low", "summary": "...", "evidence": "file:line", "hypothesis": "what would break"}
  ],
  "notes": "optional"
}
```

This is the same schema as `red-wide` — security-reviewer is a specialized red.

### Step 2: settings.json

`~/.forge/agents/security-reviewer/settings.json`:

```json
{
  "tools": ["read"],
  "notes": "Read-only. The host enforces this with a :ro mount."
}
```

In v0 this file is metadata for the operator; the actual tool restrictions are enforced at the docker mount level (`:ro`). When Claude Code adds richer settings file support, the contract is: `settings.json` is what gets passed via `--settings`.

### Step 3: wire into a workflow

Open the workflow YAML (e.g. `~/.forge/workflows/feature-ui-design-needed.yml`; source at `seeds/workflows/`; see `docs/how-to-new-workflow.md`) and add the role to a step's `reds` list:

```yaml
  - id: build
    agent: engineer
    # ...
    reds:
      - agent: red-wide
        activity: fast-orchestrator
        authority: authoritative
        gate_on_verdict: true
      - agent: security-reviewer   # ← add your new role here
        activity: fast-orchestrator
        authority: authoritative
        gate_on_verdict: true
```

You can also add the role as a blue agent in a fanout phase to run a focused security pass.

### Step 4: test

```bash
forge new feature-ui-design-needed "test-security-reviewer" \
  --brief "test brief" --design-dir /tmp/designs
forge next run-test-security-reviewer-<suffix> --project /tmp/test-project
```

Watch `~/.forge/runs/<run-id>/<task-id>/CLAUDE.md` to confirm the composed prompt looks right (Tier 1 base + any Tier 2 workflowAdditions + Tier 3 suggest constraints).

## Notes

- The agent's `model` (e.g. `"spec-writer"`, `"fast-orchestrator"`) is a logical alias resolved by LiteLLM. You don't pin a real model name in the workflow file — change the alias mapping in your LiteLLM config, the workflow re-routes automatically.
- For an authoritative red role, set `redConfig.authority: "authoritative"` and `gateOnVerdict: true`. A `fail` verdict from that red will set the blue task to `blocked_by_red`.
- The [validation contract](concepts.md#validation-contract) — hold a `status: "complete"` result that carries no `tests_run` and no `no_validation_reason` waiver — applies to a fixed set of implementer roles (`engineer`, `frontend-specialist`, `backend-specialist`, `security-advisor`, `agentic-platform-builder`). A new code-writing role you add here is **not** covered by it: the role set lives in `src/v2/validation-contract.ts` and extending it is a code change, not a seed/config change. Your seed's own validation discipline is the only thing holding the line until then.
- Constraint files at `~/.forge/constraints/` filter into the agent's prompt by `roles:`, `workflows:`, and `phases:` frontmatter. To make a new constraint apply to your role, list `security-reviewer` in `roles:`. Add `tags: [<tag>]` to scope a constraint to runs created with `forge new --tag <tag>` — useful for project-specific constraints that should not fire on every project's runs.
