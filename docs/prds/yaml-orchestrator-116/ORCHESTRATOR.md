# forge v2 — Orchestrator pattern

The orchestrator is the conversational entry surface for v2. The user runs `claude` in their forge project, the project's `CLAUDE.md` makes Claude Code the orchestrator, and the orchestrator decides what to do with each request.

This document captures the orchestrator's role, the mechanics, gate handling, and what gets written before code goes in.

## Why this exists

Forge v1's entry surface is `forge new feature "title" --brief "..."`. The user has to know which workflow to pick, what flags it takes, how to phrase the brief. The dashboard new-run form is a friendlier wrapper but still flag-shaped.

In real v1 usage, Steven was already running Claude Code on the side to help shape briefs, review planner output, and decide whether to advance gates. That informal layer IS the orchestrator. v2 makes it the primary surface.

Jeff's `project-orchestrator.md` is the model. It's a documented production pattern across his 8+ projects. Reading list:

- `~/code/de-dev-adx-example-workspaces/jeffs-workspace-boilerplate/.workspace-scaffold/agents/project-orchestrator.md` — the agent definition itself
- `~/code/de-dev-adx-example-workspaces/jeffs-workspace-boilerplate/CLAUDE.md` — the workspace entry that loads the orchestrator as the default agent

## The flow, end to end

1. **User opens Claude Code in their forge project root.** `claude` from a directory containing a `CLAUDE.md` auto-loads that file as the project's system prompt. The CLAUDE.md contains the orchestrator agent definition (forge ships a template the user pastes into their CLAUDE.md, or `forge init` writes one).

2. **User types a request.** "Add a phase-flow pill row above the dashboard task list."

3. **Orchestrator classifies.** Reads the request, decides: is this implementation? Investigation? Documentation? In-session work (write a quick script, answer a question) vs. pipeline work (full forge run)?

4. **Orchestrator drafts a brief.** Pulls together what it knows: the user's request, recent forge runs, the BACKLOG, the current branch state. Surfaces clarifying questions back to the user if material info is missing.

5. **Orchestrator presents the plan to the user.** *"I'd run the `feature` workflow with brief X. Architect will look at Y, expect Z risks. The build phase will touch these files. Proceed?"* Waits for explicit confirmation.

6. **Orchestrator invokes the pipeline.** Runs `forge new feature "phase-flow pill row" --brief "..."` via the Bash tool. `forge new` (the v2 host TS process) writes the run to SQLite and dispatches the first step in a container.

7. **Orchestrator watches the run.** Polls `forge status <runId>` or reads SQLite directly. When a step completes, reads its `result.json`.

8. **Orchestrator handles gates autonomously where it can.** For `gate: auto` steps (the v2 default), the orchestrator reads the step's output, forms an opinion, and either calls `forge next` to continue OR surfaces a concern to the user ("planner output looks thin in step 3 — want me to reject and ask for more specificity?"). For `gate: human` steps, the orchestrator surfaces the artifact to the user with its own recommendation.

9. **Pipeline completes.** Orchestrator reads final state, summarizes for the user. "Done. PR-ready diff at branch X. Verifier passed; one red raised a low-severity finding (here it is). Want me to file as follow-up or address now?"

## What lives where

| Surface | What | Where |
|---|---|---|
| Orchestrator agent prompt | Project's `CLAUDE.md` | Project root (user-owned; forge ships template) |
| Forge CLI tools (orchestrator calls these via Bash) | `forge new`, `forge status`, `forge gate`, `forge submit`, `forge show` | Already exist in v1; v2 keeps them stable for orchestrator use |
| Container agents (architect, engineer, qa-engineer, etc.) | `CLAUDE.md` + `settings.json` per role | `~/.forge/agents/<role>/` (forge-installed seeds) |
| Workflow definitions | YAML files | `~/.forge/workflows/<name>.yml` (with `<project>/.forge/workflows/<name>.yml` overrides) |
| Runtime definitions | YAML files | `~/.forge/runtimes/<name>.yml` (with project overrides) |

The orchestrator is **not** a container agent. It runs in your interactive Claude Code session, on your host, talking to you. The container agents run headless via `claude --print` and never talk to the user directly.

## Gate handling

Default `gate: auto`. Most steps don't pause. The orchestrator's responsibility on each step completion:

1. Read the step's `result.json`
2. Check against the step's expectations (declared via workflow_additions, or inferred from the role)
3. One of three outcomes:
   - **Advance silently.** Step output looks correct; call `forge next`. No user notification needed beyond a brief status update if the user is watching.
   - **Advance with a heads-up.** Output is fine but worth mentioning. *"Architect output came back; 2 risks flagged including one about Cytoscape edge inheritance. Advancing to planner."*
   - **Escalate to the user.** Output looks wrong, ambiguous, or risky. *"Planner produced 14 steps but I see at most 4 distinct concerns — looks padded. Want me to reject with rationale, or proceed?"*

When the workflow declares `gate: human` explicitly, the orchestrator's job is the same but the default outcome shifts: instead of advancing silently, the orchestrator always surfaces the artifact + its recommendation, and the user decides.

When the workflow declares `gate: verdict` (build phase with reds), the orchestrator waits for all reds to complete, reads the aggregated verdict, and:
- Pass: advances silently
- Fail (authoritative red): surfaces to user with the red's findings — *"red-frontend failed: missing focus indicators on the new pill buttons. Want me to advance over with rationale or reject?"*

## What the orchestrator does NOT do

- **Doesn't write code directly.** Implementation work goes through `forge new` → container agents.
- **Doesn't replace tickets, BACKLOG, or git workflow.** It can read/write BACKLOG.md, commit, push, but those are normal Claude Code tool uses.
- **Doesn't replace the dashboard.** Dashboard stays as the visual interface; orchestrator is the conversational interface. Both read the same SQLite. Use whichever fits.
- **Doesn't have memory across sessions** beyond what gets written to disk. Each new `claude` invocation is a fresh session that re-reads CLAUDE.md.

## What forge needs to add for this to work

Smaller than it sounds:

1. **Orchestrator prompt template.** Adapted from Jeff's `project-orchestrator.md`, tuned for forge's vocabulary (workflows, reds, gates, BACKLOG). Lives at `seeds/orchestrator-claude.md` or similar; `forge init` copies/pastes it into the project's `CLAUDE.md`.
2. **Stable CLI surface for orchestrator use.** `forge new`, `forge status --json`, `forge gate <task> --advance/--reject [--rationale]`, `forge next` all need clean exit codes and structured output. Most already exist; audit for stability before relying on them as orchestrator tools.
3. **No code orchestrator daemon.** No new background process, no MCP server, no `forge chat` command. The orchestrator is just `claude` with a good CLAUDE.md.

## Open questions

- **Should the orchestrator have access to forge's SQLite directly, or only through `forge status --json`?** Direct SQLite is faster but couples the orchestrator to the schema. CLI is slower but the contract is explicit. Lean CLI.
- **Per-project orchestrator overrides?** Different projects might want different orchestrator policies (e.g., "for this project, never advance verifier without human review"). Today the project's CLAUDE.md is the orchestrator prompt, so per-project customization is already inherent. No schema change needed.
- **What about pure-research / pure-investigation requests?** The orchestrator might decide a request doesn't need a forge run at all and just answer in-chat. Need to confirm the boundary is clear — when is forge invoked vs. when does the orchestrator handle it as conversation? Likely: any request that requires multi-agent review or persistent artifact production → forge run. Single-question lookups, code reading, BACKLOG updates → in-chat.

## Composes with v2 design

- **Gate default flip (auto, not human):** the orchestrator is what makes this safe. Without an orchestrator-as-verifier, defaulting gates to auto would be too aggressive. With orchestrator-as-verifier, it matches how forge has actually been used.
- **Agent renames:** the new vocabulary (engineer, qa-engineer, etc.) makes the orchestrator's job easier — when the user says "I want to refactor the API," the orchestrator can route to `backend-specialist` via Jeff's RACI mental model. The names communicate the routing decision.
- **DAG fanout:** orchestrator doesn't need to know about DAG fanout — that's between the planner/tech-lead and the runner. Orchestrator sees the build phase as one unit; its only concern is whether the aggregate diff looks right.
