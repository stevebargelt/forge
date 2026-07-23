# Nimbalyst / Forge Assessment

Date: 2026-07-22

Sources reviewed:

- [Nimbalyst product site](https://nimbalyst.com/)
- [Agent Harness](https://nimbalyst.com/harness/)
- [Open-source overview](https://nimbalyst.com/open-source/)
- [Pricing](https://nimbalyst.com/pricing/)
- [Trust Center](https://nimbalyst.com/trust/)
- [Nimbalyst GitHub repository](https://github.com/Nimbalyst/nimbalyst)
- Local shallow clone of `Nimbalyst/nimbalyst` at commit
  `91ff8a4e5f570f74d4f265973343c29689a99ca7`, release `v0.70.3`
- Repository implementation and design documents, including
  `THE_HARNESS.md`, `AGENT_PERMISSIONS.md`, `FILE_WATCHER_DIFF_SYSTEM.md`,
  `TRACKER_WORKFLOWS.md`, `WORKTREES.md`, `SESSION_HIERARCHY.md`, and
  `EXTENSION_ARCHITECTURE.md`

This is a product, workflow, and architecture assessment, not a formal Forge
research run or an implementation contract. Product claims and repository
behavior are current as of the date above. The Trust Center's SOC 2 Type II
statement is a company claim; the report itself was not inspected.

## Executive Take

Nimbalyst is the strongest current comparison for the operator-facing half of
Forge. It is a polished, local-first visual workspace for running coding-agent
sessions, organizing them on a board, editing the artifacts around the work,
reviewing file changes, linking sessions to tracker records, and supervising
multiple agents from desktop or mobile.

It is not a replacement for Forge's durable orchestration control plane.
Nimbalyst's workflows are deliberately easy to alter because much of the
workflow is Markdown instructions, slash commands, agent judgment, and mutable
session metadata. Forge workflows are harder to alter because execution,
claims, recovery, gates, trust boundaries, and publication behavior are
mechanically enforced. Nimbalyst optimizes interaction bandwidth; Forge
optimizes trustworthy unattended execution.

That difference is the main lesson. Forge should borrow Nimbalyst's visual
workspace, provenance, attention management, and extensibility patterns
without weakening its canonical state model. It should also create a cheaper,
explicitly lower-assurance workflow layer for experimentation. Not every
useful workflow needs to become a new hard-coded Forge execution invariant.

No new foundational work should be put on Forge's current critical path as a
result of this assessment. The near-term value is product-direction evidence
for the planned backlog, queue, dashboard, and workflow-flexibility work.

## What Nimbalyst Is

Nimbalyst describes itself as an open-source visual workspace for coding
agents. The desktop application is an Electron/React monorepo with a PGLite
and SQLite persistence layer, an iOS client, a collaboration protocol, an
extension SDK, and built-in integrations for Claude Code and Codex.

Its principal product surfaces are:

- persistent coding-agent sessions;
- a session Kanban with backlog, planning, implementing, validating, and
  complete phases;
- parallel sessions and optional Git worktrees;
- integrated tracker records with customizable fields and workflows;
- session-linked file edits, diffs, commits, pull requests, and tracker items;
- editors for Markdown, code, CSV, diagrams, mockups, data models, Mermaid,
  mind maps, and other artifacts;
- meta-agent tools for spawning and supervising other sessions;
- mobile supervision, prompts, notifications, and queued follow-up work;
- a pluggable extension system that can contribute editors, tools, settings,
  widgets, and workflow commands.

The local application and core workflows are MIT licensed. Team collaboration
and hosted synchronization are a separate commercial direction. Nimbalyst
says normal local use does not send repository content to its servers;
cloud-backed behavior is opt-in.

## The Product Model

Nimbalyst combines four products that are more separate in Forge today:

1. **Agent terminal and transcript.** Start, resume, and supervise Claude Code
   or Codex sessions.
2. **Visual project workspace.** Open the files, diagrams, mockups, datasets,
   and plans that provide or receive agent context.
3. **Work manager.** Arrange sessions and tracker records on boards and connect
   them to workstreams.
4. **Agent harness.** Supply instructions, tools, permissions, reusable
   workflows, verification practices, provenance, and coordination.

This integration is Nimbalyst's strongest advantage. The operator does not
need to reconstruct the relationship between the conversation, task, files,
diff, artifact, and Git result across multiple applications.

Forge has deeper execution and recovery semantics, but its operator currently
experiences more of those semantics through CLI output, handoffs, and
orchestrator prose. Nimbalyst is strong evidence that Forge's dashboard,
backlog, queue, run map, and evidence surfaces are product-critical rather
than cosmetic.

## How The Nimbalyst Harness Actually Works

Nimbalyst's public harness model names context, provenance, capability,
workflow, restraint, verification, visual interface, and coordination as
distinct layers. The repository's living harness document expresses nearly
the same model as instructional, capability, workflow, observability,
verification, coordination, provenance/tracking, and communication layers.

The implementation is substantial:

- repository and path-specific instructions;
- an append-only agent-mistakes log;
- MCP tools for logs, databases, renderer state, screenshots, trackers,
  settings, sessions, and extensions;
- repo-local Markdown slash commands;
- subagents and meta-agent session spawning;
- unit and Playwright testing conventions;
- session/workstream/file/tracker provenance;
- project-scoped permissions and tool approvals;
- optional worktrees and cross-session handoffs.

The repository's own instructions contain incident-derived constraints and
behavioral rules. They require fail-first tests for high-risk changes,
end-to-end verification, reading logs after exercising caught error paths,
and running observations directly instead of asking the user to do so. This
is not merely landing-page language; Nimbalyst uses its own harness seriously.

The important qualification is where the guarantees live. A large share of
the workflow is still prose interpreted by an agent:

- slash commands are Markdown files describing a sequence of actions;
- `/investigate`, `/design`, and `/implement` are conventions rather than a
  durable execution graph;
- session phase is mutable metadata set by a user or agent tool;
- the instruction that only a user may mark a session complete appears in the
  tool description, but the tool handler accepts `phase: complete`;
- workflow presets select agent behavior rather than a persisted,
  mechanically verified state machine.

This makes the harness adaptable. It also means the workflow's correctness
depends more heavily on model compliance than Forge's gates and state
transitions do.

## Workflow Flexibility: The Most Useful Comparison

Nimbalyst supports the kind of change that currently feels expensive in
Forge. A team can add a focused review workflow by writing or editing a slash
command, changing agent instructions, adding a tracker type, or installing an
extension. A red/green workflow can begin as a Markdown procedure instead of
requiring a new first-class orchestration primitive.

The cost is assurance:

| Nimbalyst-style workflow | Forge enforced workflow |
|---|---|
| Fast to author and revise | Slower to design and change |
| Primarily prompt and convention driven | State and transition driven |
| Agent decides how to interpret steps | Controller constrains valid execution |
| Good for interactive work and experimentation | Good for unattended or high-consequence work |
| Verification can be requested by prose | Verification is a gate with durable evidence |
| Recovery often means resuming a session | Recovery adopts durable work identity and receipts |

The correct Forge response is not to choose one side. Forge needs two clearly
named assurance levels:

1. **Enforced workflows** for unattended work, trust-boundary changes,
   publication, recovery, and other correctness-bearing execution.
2. **Flexible playbooks** for interactive procedures, experimental
   reviewer arrangements, research, and team-specific practices.

A playbook could initially be a versioned prompt procedure that uses existing
Forge commands and evidence surfaces. It must be labeled as agent-interpreted,
must not silently claim the guarantees of an enforced workflow, and must not
be able to bypass gates. If a playbook proves valuable and needs unattended
reliability, it can graduate into the enforced workflow model.

This is the most practical answer to the concern that changing Forge workflows
currently takes days. Forge is not wrong to make hard guarantees expensive.
It is missing a cheaper experimental layer.

## Session Kanban Is Not Forge's Queue

Nimbalyst offers two related but distinct work views:

- session phases: backlog, planning, implementing, validating, complete;
- tracker records with customizable workflow status and a default task model.

The default task model uses `to-do`, `in-progress`, `in-review`, and `done`,
with a low/medium/high/critical priority scale. Session phase can be updated by
the agent or by dragging a card. Operational session status such as idle,
running, or waiting is tracked separately.

This is useful UI, but it is not the Forge queue model:

- Forge priority is a stack rank, not a severity scale.
- `Queued` is an explicit operator decision to make an item dispatchable.
- `In progress`, `Blocked`, and `Done` should be derived from durable Forge
  state rather than manually assigned board columns.
- A blocked item retains its queue position.
- Dispatch considers capacity, existing work, and safe parallelism.

Nimbalyst validates the value of one board shared by operators and agents. It
does not invalidate Forge's stricter status semantics. Forge should borrow the
interaction pattern while preserving which fields are operator-authored and
which are derived.

## Coordination And Durability

Nimbalyst has real multi-agent coordination:

- a session can spawn or prompt other sessions;
- sessions can be grouped into workstreams;
- child completion can notify a parent;
- queued prompts are durable;
- sessions may use isolated Git worktrees;
- session metadata and activity survive restarts;
- scheduled wakeups are stored in the local database.

This is more than a collection of chat tabs. It is a credible interactive
multi-agent manager.

Its durability boundary remains desktop-session oriented. The wakeup
scheduler explicitly does not execute while the application is closed.
Overdue wakeups are surfaced on restart rather than automatically fired, and
a closed workspace postpones execution until that workspace is reopened.
Workflows are supervised through sessions rather than through an independent
durable run controller.

Forge's continuation, claim, receipt, lease, campaign, and detached-launch
work therefore remains differentiated. Forge is designed for the operator to
leave and for work to remain attributable and recoverable. Nimbalyst is
designed for the operator to have a much better cockpit while the application
and sessions are active.

## Worktrees And Safety Boundaries

Nimbalyst can create optional Git worktrees and point sessions at them. A
worktree can hold multiple sessions, while a session belongs to at most one
worktree. This provides useful branch and filesystem isolation and supports
parallel experimentation.

It is not the same as Forge's role and runtime isolation:

- the agent still operates on the host project or worktree;
- safety relies on provider permissions, Nimbalyst permission hooks, path
  policies, and the selected trust mode;
- there is no Docker or OS-level role boundary inherent in the worktree;
- permission patterns can be deliberately broad, such as remembering a class
  of Git command after one approval.

Nimbalyst's "Agent-verified" mode delegates decisions to a provider's native
classifier. That is valuable interactive permission UX, but it is a weaker
boundary than a filesystem, container, or host-side capability constraint.
Forge should borrow the clarity of project trust and visible approvals, not
replace enforceable role boundaries with classifier judgment.

The Nimbalyst repository also contains an unusually candid worktree
reliability inventory: crash gaps between Git and database changes, an
in-memory archive queue, missing operation locks, destructive squash without
a backup branch, health-validation gaps, and name-deduplication races. The
document may represent work in progress rather than current product defects,
so it should not be treated as a current bug list. It does show that
worktree-backed orchestration inherits the same cross-store and crash-window
problems Forge has been addressing explicitly.

## File Review Is Excellent UX, Not A Publication Boundary

Nimbalyst records pre-edit content for supported edit tools, watches the
filesystem, and shows pending AI changes as inline red/green diffs. Accepting
a change keeps the current disk content; rejecting it restores the prior
content. Pending review state can persist across sessions.

That is excellent operator experience. The user can see and reject agent
changes in the artifact editor instead of reading a terminal diff.

It should not be confused with pre-publication isolation:

- the agent's edit is written to the working tree before the user accepts it;
- rejection is a compensating write that restores the saved original;
- Bash edits are not pre-tagged by the same edit hook, although post-tool
  tracking may discover affected files;
- concurrent external edits and restoration behavior require careful
  ownership and conflict handling.

Forge should borrow inline evidence and review ergonomics. It should continue
to treat the actual Git state, reviewed commit, merge gate, and publication
receipt as the authority for what ships.

## Provenance Is Nimbalyst's Best Architectural Idea

Nimbalyst links:

- tracker item to session;
- session to edited files;
- workstream to the aggregate file footprint;
- tracker and session to commits and pull requests;
- decisions and plans to the work that implemented them.

This lets an operator navigate from intent to conversation to diff to Git
result. It is closer to a typed context graph than a collection of transcript
search results.

Forge already has most of the underlying identities: backlog item, run, task,
launch, route receipt, continuation, review verdict, commit, pull request, and
campaign. What it lacks is a consistently navigable projection of those
relationships.

Forge should adopt this as a dashboard principle:

> Every important work object should expose where it came from, what executed
> it, what evidence judged it, what artifact it changed, and what durable
> result it produced.

This does not require a graph database. It requires stable IDs, typed links,
and UI navigation over Forge's canonical records.

## Artifact-Centered Context

Nimbalyst's extension and editor architecture is strategically important.
Editors share a host contract for load, save, dirty state, external changes,
theme, AI diff, and selected-context reporting. An editor can pass a selected
diagram node, table region, model entity, or text fragment into the next agent
prompt as a typed context item.

This is a higher-bandwidth interaction than "tell the agent the path and line
number." It makes the artifact itself part of the conversation.

Forge should not build a general-purpose IDE now. The useful near-term lesson
is narrower:

- evidence views should let the operator select a run, task, finding, receipt,
  backlog item, or diff fragment and hand that exact object to the
  orchestrator;
- the selected object should be represented by stable identity and structured
  fields, not only rendered prose;
- an agent answer should link back to the object it interpreted;
- dashboard extensions should eventually be able to add bounded evidence
  renderers without owning core orchestration state.

## Mobile And Attention Management

Nimbalyst treats supervision as an attention-routing problem. Mobile surfaces
can show active sessions, notify the operator, relay questions, and queue
follow-up work.

Forge has been solving whether work continues correctly. Nimbalyst highlights
the adjacent product question: when does the operator actually need to care?

A Forge attention inbox should eventually distinguish:

- running normally;
- awaiting an operator decision;
- blocked by an external dependency;
- review or gate failed;
- recovery happened automatically;
- completed and ready for summary;
- anomalous state needing intervention.

This projection should be derived from Forge state. It should not create a
second mutable lifecycle.

## Relationship To The Vjeko Workflow

The Vjeko workflow assessment emphasized narrow, adversarial, specialized
reviewers rather than a pile of generic reviewers. Nimbalyst demonstrates the
other half of that idea: those roles can be expressed cheaply as focused
commands, checklists, or spawned sessions.

Forge currently has the stronger durable gate and evidence model, but role
specialization is expensive to change. Nimbalyst has the more flexible role
composition model, but weaker mechanical guarantees that every role ran,
examined the intended artifact, and produced binding evidence.

The synthesis for Forge is:

1. Define focused reviewer playbooks cheaply.
2. Let the operator experiment with their checklists and ordering.
3. Record which playbook, version, artifact, and result were used.
4. Promote only mature, correctness-bearing reviewers into enforced gates.
5. Avoid counting several correlated model opinions as independent proof.

This permits a Vjeko-style red/green experiment without first redesigning the
entire Forge workflow engine.

## What Forge Should Borrow

### Near term

1. **One operator board.** Backlog, explicit queue, live work, blockers, and
   completed work in one surface, while keeping derived state derived.
2. **Attention states.** Make "needs operator" more prominent than generic
   running/idle status.
3. **Typed provenance navigation.** Link backlog item → run → task → evidence
   → diff/commit/PR and back.
4. **Artifact-to-agent handoff.** Let the operator select a concrete Forge
   object and ask the orchestrator about it.
5. **Focused playbooks.** Add a low-cost, versioned, agent-interpreted workflow
   layer that cannot bypass enforced gates.

### Later

6. **Pluggable evidence renderers.** Allow bounded dashboard extensions for
   new artifact and evidence types.
7. **Mobile or remote attention inbox.** Optimize for decisions and anomalies,
   not a full remote IDE.
8. **Cross-session/workstream views.** Show all work and file impact related
   to one backlog item or campaign.
9. **Visual diff review.** Improve review ergonomics without treating a
   retrospective accept button as publication authority.

## What Forge Should Not Copy

1. Mutable board columns as the authority for execution state.
2. A severity-style priority scale in place of queue stack rank.
3. Prompt instructions as the only enforcement of completion or review
   policy.
4. Scheduled desktop wakeups as the completion path for unattended work.
5. Provider classifier decisions as a substitute for enforceable runtime
   capabilities.
6. File-diff acceptance as proof that the reviewed artifact is what shipped.
7. A second general-purpose IDE before Forge's existing dashboard and queue
   are usable.
8. Nimbalyst's full vocabulary and state surface. Forge should preserve a
   smaller canonical model and build better projections over it.

## Competitive Position

The products overlap, but their centers of gravity differ:

| Dimension | Nimbalyst | Forge |
|---|---|---|
| Primary product | Visual agent workspace | Durable orchestration control plane |
| Operator experience | Strong, integrated, artifact-centered | Emerging, currently more CLI/handoff centered |
| Workflow changes | Cheap Markdown, prompts, presets, extensions | Expensive because behavior is enforced |
| Unattended durability | Session/app oriented | Launch, continuation, claim, receipt, and campaign oriented |
| Task state | Customizable mutable trackers and boards | Moving toward canonical backlog, queue, and derived execution state |
| Safety | Trust modes, permission hooks, worktrees, diffs | Runtime roles, gates, durable evidence, publication boundaries |
| Provenance | Strong navigable session/artifact graph | Strong IDs and evidence, weaker operator projection |
| Artifact editing | Broad visual editor platform | Deliberately not an IDE |
| Mobile | Active product surface | Future attention opportunity |

Nimbalyst could move toward deeper orchestration by strengthening its
meta-agent and durable state. Forge could move toward Nimbalyst by improving
the dashboard, queue, provenance, and interaction model. The competitive risk
is not that Nimbalyst already duplicates Forge's guarantees. It is that its
superior operator experience may be sufficient for many users who do not need
those guarantees.

Forge's differentiation must therefore be visible. "Correct recovery and
trustworthy execution" cannot remain an internal architecture achievement
that the operator experiences mainly as long implementation projects. The
dashboard should make receipts, gates, recovery, evidence, and derived state
feel like product capabilities.

## Possible Integration

Because Nimbalyst is MIT licensed and extension-driven, a Forge extension or
MCP integration is technically plausible. It could expose Forge backlog
items, queue state, runs, gates, and evidence inside Nimbalyst.

That is not recommended as current critical-path work:

- Forge already has a dashboard direction;
- adopting another desktop application's state and extension lifecycle would
  create a large integration dependency;
- Forge's canonical state must remain outside the UI shell;
- the product relationship and long-term licensing of hosted collaboration
  are not yet relevant enough to justify coupling.

A future bounded spike could test whether a read-only Forge evidence extension
is valuable. For now, borrow interaction patterns and keep Forge's UI
architecture independent.

## Recommended Forge Disposition

1. Keep the current post-FG-583 plan. Do not reopen the foundational sequence.
2. Use this assessment as evidence for the backlog/queue/dashboard work
   already planned.
3. When workflow flexibility becomes active work, define the two assurance
   levels explicitly: flexible playbook and enforced workflow.
4. Prototype one narrow Vjeko-style reviewer playbook using existing Forge
   commands before designing a general workflow editor.
5. Add provenance navigation and an operator attention view before attempting
   a broad visual artifact workspace.
6. Revisit Nimbalyst after Forge's queue and dashboard flow are usable. At
   that point the comparison can be tested through real operator tasks rather
   than feature lists.

## Bottom Line

Nimbalyst is not evidence that Forge chose the wrong foundation. It is
evidence that Forge has underinvested in the layer through which a human
experiences that foundation.

The architectural lesson is to keep Forge's durable authority while adding a
cheaper, non-authoritative workflow layer. The product lesson is to make the
queue, evidence, provenance, and requests for attention visible in one place.
The strategic lesson is that reliability only differentiates Forge if the
operator can see, understand, and benefit from it without spending days
building each new workflow.
