# forge RACI — work-type routing for the orchestrator

The orchestrator reads this on every request to classify the prompt and pick a route.

**How to use this file:**
- Rows marked `[default]` ship with forge — don't modify unless a project genuinely needs different routing
- Rows marked `[project]` are project-customizable (override by copying this file to `<project>/.forge/forge-raci.md`)
- If a specialist agent doesn't exist on your machine (`~/.forge/agents/<role>/` missing), the orchestrator handles that work type directly in-session

---

## Work type taxonomy

Classify every incoming prompt into ONE of these types before looking up the RACI. If a prompt spans multiple types, **split and sequence** — decompose into discrete work items, route each in order.

| Work Type | Prompt examples |
|-----------|-----------------|
| `strategy` | "What should I prioritize?", "Is this worth building?", "What's the LOE on this?" |
| `planning` | "What should I work on next?", "Help me triage the backlog" |
| `ticketing` | "File a backlog item for X", "Move #N to Done", "Refresh BACKLOG.md notes" |
| `implementation` | "Build feature X", "Fix bug Y", "Refactor Z" — the work type that triggers the **pipeline** (full) or **invoke chain** (quick) |
| `testing` | "Write tests for X", "Add E2E coverage for the dashboard", "Test this feature", "QA the latest changes", "Catch up on test coverage" |
| `documentation` | "Document how X works", "Update CLAUDE.md", "Write a how-to for Y" |
| `research` | "How does X work?", "What does Z's source say about Y?", "Investigate this claim" |
| `review` | "Review my plan", "Audit this diff", "Red-team this artifact" |
| `architecture` | "Should I use X or Y?", "Design the boundaries for Z", "What's the right pattern?" |
| `ui-design` | "Design the UI for X", "Revise the existing design for Y" |
| `orientation` | "What's the current state?", "Where were we?", "What's in flight?" |
| `meta` | "How does forge work?", "Update the orchestrator template", "Add a new agent" |

---

## RACI table

Columns (standard RACI):
- **Responsible** — the agent that DOES the work. **Exactly one** value per row. (For `implementation`, the selection happens via sub-rule at routing time but the cell points to a single chosen agent.)
- **Accountable** — the party that OWNS the outcome — signs off, takes the blame, has the final call. **Exactly one** value per row.
- **Consulted** — two-way communication BEFORE work begins. The orchestrator invokes consulted agents first and folds their input into the brief for the Responsible agent. **Can be multiple** (comma-separated).
- **Informed** — one-way communication AFTER work completes. Notification, not decision-making input. **Can be multiple** (comma-separated). For forge this is mostly file updates (BACKLOG.md, ADRs), not agent invocations.

Plus a forge-specific column:
- **Path** — how the orchestrator invokes the Responsible work. `in-session` = orchestrator does it directly in chat; `invoke` = `forge invoke <agent>`; `pipeline` = `forge new <workflow>`.

| Work Type | Responsible | Accountable | Consulted | Informed | Path | Row |
|-----------|-------------|-------------|-----------|----------|------|-----|
| `strategy` | orchestrator | orchestrator | `architecture-advisor` (when scope is non-trivial) | — | in-session | [default] |
| `planning` | orchestrator | orchestrator | `architecture-advisor` (when sequencing depends on architectural risk) | — | in-session | [default] |
| `ticketing` | orchestrator | orchestrator | — | — | in-session | [default] |
| `implementation` (full) | see sub-rule ¹ | orchestrator | `architecture-advisor` (sub-rule ²) | — | **pipeline** (`forge new feature`) | [default] |
| `implementation` (quick) | `engineer` (sub-rule ⁵) | orchestrator | — | — | **invoke chain** (sub-rule ⁵) | [default] |
| `testing` (automation) | `test-engineer` | orchestrator | — | — | invoke | [default] |
| `testing` (exploratory) | `manual-qa` | orchestrator | — | — | invoke | [default] |
| `documentation` | orchestrator | orchestrator | subject-matter specialist (sub-rule ³) | — | in-session | [default] |
| `research` | `research-specialist` | orchestrator | — | — | invoke | [default] |
| `review` (wide) | `red-wide` | orchestrator | — | — | invoke | [default] |
| `review` (narrow) | `red-narrow` | orchestrator | — | — | invoke | [default] |
| `review` (frontend) | `red-frontend` | orchestrator | — | — | invoke | [default] |
| `review` (backend) | `red-backend` | orchestrator | — | — | invoke | [default] |
| `review` (security) | `red-security` | orchestrator | — | — | invoke | [default] |
| `architecture` | `architecture-advisor` | orchestrator | relevant specialist (sub-rule ³) | — | invoke | [default] |
| `ui-design` | `prompt-author` | user | — | — | invoke + manual handoff ⁴ | [default] |
| `orientation` | orchestrator | orchestrator | — | — | in-session | [default] |
| `meta` | orchestrator | orchestrator | — | — | in-session | [default] |

---

## Routing sub-rules

**¹ `implementation` specialist selection** (the tech-lead chooses, NOT the orchestrator):
- The implementation pipeline (`forge new feature`) runs architect → tech-lead → engineer → test-engineer with reds
- The **tech-lead** decides which engineer specialist handles each plan step:
  - Backend-only work → `backend-specialist`
  - Frontend-only work → `frontend-specialist`
  - Security-sensitive work (auth, crypto, secret handling, input validation) → `security-advisor`
  - Cross-layer, full-stack, or platform/agentic work → `agentic-platform-builder`
  - General single-layer work without a clear specialty → `engineer` (the generalist)
- The orchestrator's job is **just** to kick off the pipeline — it doesn't pre-route to a specialist

**² `architecture-advisor` consult on `implementation`:**
- The pipeline already includes an `architect` phase as the first step. The orchestrator does NOT pre-consult architecture-advisor before invoking the pipeline — the pipeline handles that.
- The "Consulted" entry here is informational: the pipeline DOES consult the architecture-advisor as its first phase.

**³ Subject-matter specialist selection** (for `documentation` and `architecture` consults):
- Backend domain → `backend-specialist`
- Frontend domain → `frontend-specialist`
- Security domain → `security-advisor`
- Full-stack / platform / agentic domain → `agentic-platform-builder`
- Research-shaped questions → `research-specialist`
- Skip the consult if no relevant specialist exists on the host

**⁴ `ui-design` manual handoff:**
- `prompt-author` runs in a container and produces `PROMPT.md` (this is the `invoke` part)
- The human (you) then runs `PROMPT.md` against Pencil + Claude Code on the host, exports `.pen` + `designs/*.png` + `code/*.html`, and runs `forge submit <task-id>` to hand the artifacts back to forge
- This second phase is intentionally NOT a RACI row because no agent is involved — it's irreducibly human work. The orchestrator's job is to make sure the user knows the handoff is theirs to drive
- Accountable = user because design judgment is irreducibly the user's call

**⁵ `implementation` (quick) — invoke chain for small changes:**

Not every implementation task needs the full pipeline. Bug fixes, small features, UI tweaks, and targeted refactors use the quick path: a chain of invokes driven by the orchestrator. The orchestrator picks the path based on scope — see "Full vs quick implementation" below.

The quick chain:
```
forge invoke engineer --task "..." --run-title "<title>"
# read result, verify engineer self-validated, then ALWAYS:
forge invoke test-engineer --task "verify: <what the engineer changed>" --run <same-run-id>
# for UI-facing changes on web apps, optionally:
forge invoke manual-qa --task "exploratory test of <feature>" --run <same-run-id>
```

Key rules:
- **test-engineer is NOT optional** in the quick chain. The whole point of quick implementation is to skip ceremony (architect, tech-lead, reds) without skipping verification. The engineer builds; the test-engineer proves it works. Skipping the test-engineer invoke is how "simple UI updates" break the app.
- The engineer specialist selection follows the same logic as sub-rule ¹ — the orchestrator picks the right specialist (`frontend-specialist`, `backend-specialist`, etc.) based on the task.
- manual-qa is optional and at the orchestrator's judgment. Invoke it when the change is user-facing, visual, or high-risk.
- No reds run in the quick path. If the change warrants adversarial review, use the full pipeline.

**Full vs quick implementation — how the orchestrator decides:**

| Signal | Path |
|--------|------|
| New feature, multi-file, architectural implications | Full pipeline |
| Cross-cutting change spanning multiple layers | Full pipeline |
| Work that needs an architect's risk assessment | Full pipeline |
| Bug fix in a single module | Quick chain |
| Small feature addition (one or two files) | Quick chain |
| UI tweak, styling change, copy update | Quick chain |
| Targeted refactor within clear boundaries | Quick chain |

When in doubt, ask the user: "This looks small enough for a quick invoke chain — or would you prefer the full pipeline?"

**Review routing**: the five `review (...)` rows are independent. The orchestrator selects which reviews to run based on the artifact:
- Always run `review (wide)` and `review (narrow)` for any non-trivial diff or artifact
- Add `review (frontend)` when the artifact touches UI / styles / accessibility
- Add `review (backend)` when the artifact touches APIs / data / business logic
- Add `review (security)` when the artifact touches auth / crypto / secrets / input validation
- Selected reviews run in parallel via simultaneous `forge invoke` calls; verdicts aggregate at the orchestrator level (similar to how the pipeline's `gate: verdict` aggregates reds)

---

## Routing behavior rules

**Multi-type prompts — split and sequence.**
"Build feature X and document it" decomposes into TWO work items: one `implementation` (pipeline), one `documentation` (in-session, after implementation completes). Route in order; surface the plan to the user before executing.

**Consulted agents are synchronous.**
The orchestrator pauses, runs `forge invoke <consulted-agent>`, reads the result, folds it into the brief for the Responsible agent, then proceeds. If a Consulted agent isn't installed (no `~/.forge/agents/<role>/` dir), skip and note the gap in the user-facing summary.

**Informed targets are downstream parties to notify after work completes.**
For forge today, most rows have no Informed (—). The orchestrator carries each agent's output forward as context for the next invocation rather than relying on persistent inter-agent notification.

**Work-closure hygiene is separate from RACI Informed.** After any work completes, the orchestrator may need to:
- Update BACKLOG.md (when a tracked ticket changes state, or to capture a note worth a future session)
- Write to `learnings/decisions/<name>.md` (for architectural decisions worth keeping)
- Write to `learnings/patterns/<name>.md` (for cross-cutting patterns worth re-using)

These are *project hygiene*, not *informing parties*. The orchestrator does them as part of completing the request. They don't belong in the RACI's Informed column.

**Ambiguous prompts.**
If a prompt can't be classified after one read, ask ONE targeted clarifying question. Don't ask for a full spec — just enough to pick the right work type.

**The `implementation` trigger is strict.**
Only `implementation` work modifies source code. It takes one of two paths — full pipeline (architect → tech-lead → engineer → test-engineer with reds) for substantial work, or quick invoke chain (engineer → test-engineer, optionally manual-qa) for small changes. Both paths include test-engineer verification. Even complex multi-agent work in other categories (e.g., a research task that needs `research-specialist` + then `synthesizer`-style aggregation) is orchestrator-driven via multiple `forge invoke` calls without a pipeline.

**The `testing` trigger is standalone.**
`testing` work does NOT modify source code (other than adding test files). It's always a direct invoke — `test-engineer` for writing automated tests, `manual-qa` for exploratory testing. Use `testing` for catch-up coverage ("write integration tests for the auth flow"), post-hoc verification ("test the dashboard changes"), or test backfill ("we need E2E tests for module X").

**When the orchestrator is "Responsible" itself.**
Many rows have the orchestrator as Responsible (strategy, planning, ticketing, orientation, meta). This is intentional — those work types are conversation-shaped, not artifact-shaped. The orchestrator does them in the chat with the user, optionally consulting specialists for input. No `forge invoke` needed.

---

## Path conventions

- **`in-session`** — orchestrator handles in the conversation directly. No container, no run row. Examples: updating BACKLOG.md, answering "what's in flight," writing rationale for a ticket.
- **`invoke`** — `forge invoke <agent-role> --task "<description>" --project <dir>`. Spawns one container with the named agent, returns when done, writes a one-step run row visible in the dashboard. Most non-implementation work uses this.
- **`pipeline`** — `forge new feature "<title>" --brief "<brief>" --project <dir>`. Multi-step workflow with gates and reds. Reserved for `implementation`.

---

## Notes for the orchestrator

- **Always present a plan before kicking off any `invoke` or `pipeline` work.** Tell the user: which agent, what task, why this routing. Wait for confirmation.
- **Most user requests resolve in one or two invokes.** A research question is one `research-specialist` invoke. An architecture question is one `architecture-advisor` invoke. A "build this feature" request is one `forge new feature` pipeline. Don't over-decompose.
- **You can chain invokes for complex non-implementation work.** If the user asks "research X and then propose an architecture for it," that's a `research-specialist` invoke followed by an `architecture-advisor` invoke — both driven by you, no pipeline.
- **When in doubt, ask the user.** Routing is your judgment call but you're not infallible. "I'd handle this as research — sound right?" is cheap insurance.

---

## Routing log

The orchestrator appends a one-line entry to `<project>/.forge/routing-log.md` after every routed request (if the file exists; created lazily when the first non-trivial request is routed). Useful for after-the-fact "why did the orchestrator do X" auditing.

```
| Date | Prompt summary | Classified | Responsible | Consulted | Path |
```
