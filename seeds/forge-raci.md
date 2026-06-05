# forge RACI — work-type routing for the orchestrator

This file is the **human-authored source** for routing. The `### route:` blocks
below are the canonical, machine-readable record: they compile to
`routing-policy.yml` (the derived execution policy the orchestrator and provider
adapters consume). See `docs/prds/raci-routing-policy.md`.

Two kinds of content live here:
- **Route blocks** (`### route: <key>`) — compiled. One constrained record block
  per route, fixed fields, brutal parse rules (below).
- **Routing guidance** — everything else is non-compiled human context, ignored
  by the compiler. Prose that materially affects routing is prefixed
  `Routing guidance:` / `Notes:` so the parser boundary is obvious.

**How to use this file:**
- These routes ship with forge — don't modify unless a project genuinely needs
  different routing.
- A project overrides by copying this file to `<project>/.forge/forge-raci.md`.
- If a `responsible` agent isn't installed on the host (`~/.forge/agents/<role>/`
  missing), the orchestrator handles that work type directly in-session.

**Record-block grammar (brutal + simple):**
- A route block starts with `### route: <route_key>`. Route keys are unique.
- Fixed lowercase field names, one `key: value` per line, no multiline values.
- Required: `classification_hints`, `responsible`, `accountable`, `path`,
  `consulted`, `required_followups`, `informed`, `force_rules`.
- `command` is required iff `path: cli`; forbidden otherwise.
- `path` enum: `in_session`, `invoke`, `invoke_chain`, `workflow`, `manual`, `cli`.
- `responsible` is the dispatch target for non-`cli` paths (agent role / workflow
  name / `human` / `orchestrator`); for `cli`, `responsible` is the action symbol
  and `command` is what runs.
- `accountable` is `human` in every block — the visible governance reminder. The
  compiler hoists it to the policy header; outcomes are always the human's.
- Lists are comma-separated symbols; `none` is the only empty-list sentinel.
- `informed` targets may be conditional: `name:when=condition`.
- `classification_hints` are advisory — the orchestrator may use them to choose a
  route; forge code never keyword-matches prompts into routes.

---

## Work type taxonomy

Classify every incoming prompt into ONE work type before routing. If a prompt
spans multiple types, **split and sequence** — decompose into discrete work
items, route each in order. The `classification_hints` in each route block carry
example phrasing.

---

## Routes

### route: strategy

classification_hints: what should I prioritize, is this worth building, what's the LOE
responsible: orchestrator
accountable: human
path: in_session
consulted: none
required_followups: none
informed: user_summary
force_rules: none

### route: planning

classification_hints: what should I work on next, help me triage the backlog
responsible: orchestrator
accountable: human
path: in_session
consulted: none
required_followups: none
informed: user_summary
force_rules: none

### route: ticketing

classification_hints: file a backlog item, move to done, refresh notes
responsible: orchestrator
accountable: human
path: in_session
consulted: none
required_followups: none
informed: user_summary, backlog:when=ticketed
force_rules: none

### route: implementation_full

classification_hints: architectural novelty, unclear boundaries, missing implementation plan, new integration shape, high-risk decomposition
responsible: feature
accountable: human
path: workflow
consulted: none
required_followups: none
informed: user_summary, backlog:when=ticketed, docs_impact:when=operator_behavior_changed
force_rules: none

### route: implementation_quick

classification_hints: bug fix, small feature, ui tweak, targeted refactor, precedent-based multi-file change, existing implementation plan, clear bounded change
responsible: engineer
accountable: human
path: invoke_chain
consulted: affected_code, existing_tests
required_followups: test-engineer
informed: user_summary, backlog:when=ticketed, docs_impact:when=operator_behavior_changed
force_rules: none

### route: testing_automation

classification_hints: write tests, add e2e coverage, test backfill, catch up coverage
responsible: test-engineer
accountable: human
path: invoke
consulted: none
required_followups: none
informed: user_summary
force_rules: none

### route: testing_exploratory

classification_hints: exploratory test, QA the changes, poke edge cases
responsible: manual-qa
accountable: human
path: invoke
consulted: none
required_followups: none
informed: user_summary
force_rules: none

### route: documentation_durable

classification_hints: document how X works, write a how-to, update operator docs, write an ADR
responsible: documentation-maintainer
accountable: human
path: invoke
consulted: none
required_followups: none
informed: user_summary, docs_impact:when=operator_behavior_changed
force_rules: none

### route: documentation_ephemeral

classification_hints: session notes, task brief, scratch draft, small status note
responsible: orchestrator
accountable: human
path: in_session
consulted: none
required_followups: none
informed: user_summary
force_rules: none

### route: research

classification_hints: how does X work, what does the source say, investigate this claim
responsible: research-specialist
accountable: human
path: invoke
consulted: none
required_followups: none
informed: user_summary
force_rules: none

### route: review_wide

classification_hints: audit this diff, broad review, review my plan
responsible: red-wide
accountable: human
path: invoke
consulted: affected_code
required_followups: none
informed: user_summary
force_rules: none

### route: review_narrow

classification_hints: deep review, narrow audit, scrutinize this change
responsible: red-narrow
accountable: human
path: invoke
consulted: affected_code
required_followups: none
informed: user_summary
force_rules: none

### route: review_frontend

classification_hints: ui review, accessibility audit, styles review
responsible: red-frontend
accountable: human
path: invoke
consulted: affected_code
required_followups: none
informed: user_summary
force_rules: none

### route: review_backend

classification_hints: api review, data review, business-logic audit
responsible: red-backend
accountable: human
path: invoke
consulted: affected_code
required_followups: none
informed: user_summary
force_rules: none

### route: review_security

classification_hints: security audit, auth review, crypto review, secrets review
responsible: red-security
accountable: human
path: invoke
consulted: affected_code
required_followups: none
informed: user_summary
force_rules: none

### route: architecture

classification_hints: should I use X or Y, design the boundaries, what's the right pattern
responsible: architecture-advisor
accountable: human
path: invoke
consulted: none
required_followups: none
informed: user_summary
force_rules: none

### route: ui_design

classification_hints: design the UI, revise the existing design
responsible: prompt-author
accountable: human
path: invoke
consulted: design_artifacts
required_followups: none
informed: user_summary, handoff_notes:when=session_boundary
force_rules: none

### route: orientation

classification_hints: what's the current state, where were we, what's in flight
responsible: orchestrator
accountable: human
path: in_session
consulted: none
required_followups: none
informed: user_summary
force_rules: none

### route: meta

classification_hints: how does forge work, update the orchestrator template, add a new agent
responsible: orchestrator
accountable: human
path: in_session
consulted: none
required_followups: none
informed: user_summary
force_rules: none

---

## Routing guidance (NOT compiled)

Everything below is non-compiled human guidance. The compiler ignores it; it
exists to capture judgment the record blocks can't express. Where a note
materially affects routing it is prefixed `Routing guidance:`.

**Routing guidance: `strategy` / `planning` consults.** When scope is non-trivial
(or sequencing depends on architectural risk), the orchestrator may first invoke
`architecture-advisor` and fold its input into the answer. This consult is a
judgment call, not a hard rule, so the route blocks carry `consulted: none`.

**Routing guidance: `implementation_full` specialist selection** (the tech-lead
chooses, NOT the orchestrator). The pipeline (`forge new feature`, the `feature`
workflow) runs architect → tech-lead → engineer → test-engineer with reds. The
tech-lead decides which engineer specialist handles each plan step:
- Backend-only → `backend-specialist`
- Frontend-only → `frontend-specialist`
- Security-sensitive (auth, crypto, secret handling, input validation) → `security-advisor`
- Cross-layer / full-stack / platform/agentic → `agentic-platform-builder`
- General single-layer work → `engineer` (generalist)

The orchestrator's job is just to kick off the pipeline. The architect phase is
the pipeline's own first step — the orchestrator does NOT pre-consult
architecture-advisor (hence `consulted: none` on `implementation_full`).

**Routing guidance: `implementation_quick` — invoke chain.** Bug fixes, small
features, UI tweaks, targeted refactors, and precedent-driven multi-file changes
that already have a concrete plan skip the pipeline. The engineer
builds and self-validates; then the **test-engineer is NOT optional** —
`required_followups: test-engineer` is mandatory. Skipping it is how "simple UI
updates" break the app. manual-qa is optional at the orchestrator's judgment for
user-facing/visual/high-risk changes. No reds run in the quick path. The engineer
specialist is picked the same way as the pipeline's (frontend-specialist,
backend-specialist, etc.).

Routing guidance: Full vs quick — the discriminator is architectural novelty and
plan-certainty, NOT file count. Use the full pipeline (`implementation_full`)
when the work is architecturally novel, has unclear boundaries, lacks a concrete
implementation plan, introduces a new integration shape, or carries risk that
needs an architect + tech-lead to decompose. Use the quick chain
(`implementation_quick`) for precedent-driven work — INCLUDING multi-file,
cross-cutting changes — when the pattern is already established in the codebase,
the implementation plan is concrete (a written plan doc, or a clear existing
precedent to mirror), and the change is bounded. Multi-file or cross-cutting
alone does NOT force the full pipeline; ceremony without risk reduction is waste.
The mandatory `test-engineer` followup and `docs_impact` handling apply to the
quick chain exactly as in any quick implementation — quick never means unverified
or undocumented. When you genuinely can't tell whether the boundaries or risk
need an architect, ask the user.

**Routing guidance: subject-matter specialist consults** (for
`documentation_durable` and `architecture`). The specific specialist is chosen at
routing time — backend → `backend-specialist`, frontend → `frontend-specialist`,
security → `security-advisor`, full-stack/platform → `agentic-platform-builder`,
research-shaped → `research-specialist`. Because the choice is sub-rule-driven (no
single fixed symbol), the route blocks carry `consulted: none`; skip the consult
if no relevant specialist exists on the host.

**Routing guidance: `documentation` durable vs ephemeral.** Ephemeral
working-state → orchestrator edits directly (`documentation_ephemeral`): BACKLOG
via `forge backlog`, session handoff notes, task briefs, scratch drafts. Durable
operator-/engineer-facing prose → `documentation-maintainer`
(`documentation_durable`): `docs/**`, `learnings/decisions/**` +
`learnings/patterns/**`, `README*`, seed prose/templates, how-tos, ADRs, example
configs. Mechanical exception: re-rendering `CLAUDE.md` via `forge upgrade` and
marker-repair are orchestrator-direct. If the maintainer isn't installed, note
the gap and fall back to a direct edit.

**Routing guidance: `ui_design` manual handoff.** `prompt-author` runs in a
container and produces `PROMPT.md` (the `invoke` the route block names). The human
then drives Pencil + Claude Code on the host, exports `.pen` + `designs/*.png`,
and runs `forge submit <task-id>` to hand the artifacts back — irreducibly human
work that no route block models. Outcome accountability is the human's
(`accountable: human`).

**Routing guidance: `review` selection.** The five review routes are independent.
Always run `review_wide` and `review_narrow` for any non-trivial artifact; add
`review_frontend` when it touches UI/styles/accessibility, `review_backend` for
APIs/data/business-logic, `review_security` for auth/crypto/secrets/input
validation. Selected reviews run in parallel; verdicts aggregate at the
orchestrator level.

**Routing guidance: `research` target.** Today `research` dispatches the installed
`research-specialist` agent (`path: invoke`). When #251 lands a v2-native
`research-synthesis` workflow, repoint this route to that workflow
(`path: workflow`, `responsible: research-synthesis`). Kept on today's agent until
then.

**Routing guidance: multi-type prompts — split and sequence.** "Build feature X
and document it" decomposes into `implementation_full` then `documentation_durable`
(on the same run, after implementation). When implementation changes
operator-visible behavior, the documentation item is implied even if unasked —
resolve the docs-impact lifecycle and report the final `Docs impact: updated |
not needed: <reason> | deferred: #<ticket>` line (or `none`); a non-`none` impact
must be resolved before the run is complete, and a deferral requires a filed
backlog ticket.

**Routing guidance: consulted agents are synchronous.** The orchestrator pauses,
runs `forge invoke <consulted-agent>`, reads the result, folds it into the brief
for the responsible agent, then proceeds. If a consulted agent isn't installed,
skip and note the gap.

Notes: `informed` targets are post-work closure hygiene (record/surface targets),
not agent notifications. Work-closure hygiene (updating BACKLOG, writing ADRs to
`learnings/decisions/**` or patterns to `learnings/patterns/**`) is project
hygiene the orchestrator does as part of completing the request.

Notes: when the orchestrator is `responsible` itself (strategy, planning,
ticketing, documentation_ephemeral, orientation, meta) the work is
conversation-shaped — handled in chat, no `forge invoke`. Always present a plan
before kicking off any `invoke` or `workflow` work; most requests resolve in one
or two invokes; when in doubt, ask the user.

---

## Path conventions

- **`in_session`** — orchestrator handles it in the conversation. No container,
  no run row.
- **`invoke`** — `forge invoke <agent-role> --task "<description>"`. One
  container, returns when done, one-step run row.
- **`invoke_chain`** — a sequence of invokes the orchestrator drives (e.g.
  engineer → test-engineer) without a pipeline.
- **`workflow`** — `forge new <workflow>`. Multi-step run with gates and reds.
- **`manual`** — irreducibly human work on the host (no agent dispatched).
- **`cli`** — a direct forge CLI operation; the literal invocation is in `command`.

---

## Routing log

The orchestrator appends a one-line entry to `<project>/.forge/routing-log.md`
after every routed request (created lazily on first non-trivial routing). Useful
for after-the-fact "why did the orchestrator route X this way" auditing.

```
| Date | Prompt summary | Classified | Responsible | Consulted | Path |
```
