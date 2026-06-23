# GasTown / GasCity Assessment Compared To Forge

Date: 2026-06-22

GasTown source inspected: [`gastownhall/gastown`](https://github.com/gastownhall/gastown), local shallow clone at `/private/tmp/gastown-research`, commit `5118351294c8e3cad288314b9a9b7d106ebce960` from 2026-06-17.

## Executive Take

GasTown is one of the more serious attempts I have seen at treating AI coding agents as an operating system problem instead of a prompt-routing problem. Its strongest ideas are durable work identity, explicit agent identity, persistent agent mail, worktree-backed isolation, convoy-level progress tracking, a merge queue, capacity scheduling, and recoverable long-running agent sessions.

The caution for Forge is equally strong: GasTown solves complexity by building a whole city of concepts. That is coherent, but it is also a warning. Forge's current risk is already operational complexity. We should borrow GasTown's durable-state and visibility patterns, not its vocabulary density or its expectation that a human/operator understands a large CLI-first town model.

The most useful lesson for Forge is this: every hidden orchestration decision needs a visible object in the dashboard. GasTown has Beads, convoys, mail, agent CVs, merge requests, integration branches, scheduler contexts, and escalations. Forge should keep fewer nouns, but make them first-class in the dashboard: run, task, gate, review, receipt, route, backlog item, control-plane source, worktree/branch when present, and escalation.

## What GasTown Is

GasTown is a multi-agent workspace manager for coding agents. The public README describes it as coordinating Claude Code, Copilot, Codex, Gemini, and other agents, with persistent work tracking and git-backed hooks. Its top-level model is a town containing rigs, crews, polecats, hooks, convoys, Beads, a Mayor, a Deacon, Witnesses, Dogs, and a Refinery.

Core pieces:

- **Town:** the host workspace, normally under `~/gt`.
- **Rig:** a project/repository container.
- **Mayor:** primary coordinator.
- **Crew:** persistent user-controlled agents or workspaces.
- **Polecat:** worker agent identity with an ephemeral session and persistent work history.
- **Hook:** git worktree-backed storage/sandbox for work.
- **Beads:** git/Dolt-backed issue/work ledger.
- **Convoy:** durable tracker for a group of related work items.
- **Molecule/Wisp:** workflow templates and attached execution units.
- **Witness/Deacon/Dogs:** watchdog and recovery chain.
- **Refinery:** merge queue and integration branch manager.
- **Scheduler:** capacity governor for dispatch.
- **GasCity:** planned declarative layer over GasTown roles/formulas; docs describe it as forward-looking rather than a complete standalone system.

Sources: [README](https://github.com/gastownhall/gastown/blob/main/README.md), [overview](https://github.com/gastownhall/gastown/blob/main/docs/overview.md), [glossary](https://github.com/gastownhall/gastown/blob/main/docs/glossary.md), [architecture](https://github.com/gastownhall/gastown/blob/main/docs/design/architecture.md), [Gas City provider notes](https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md).

## Strong Ideas Worth Borrowing

### 1. Durable Work Ledger

GasTown's deepest idea is that work is not just a process running in a terminal. Work is a queryable object with identity, relationships, status, actor attribution, history, messages, and merge state.

Forge already has the right foundation with SQLite runs/tasks/events, backlog files, verdicts, failure kinds, gates, and task manifests. The next move is not a new ledger technology. It is making Forge's existing ledger more inspectable:

- a run map that shows actual execution state, not just planned workflow shape;
- a backlog viewer that links backlog items to runs/tasks/results;
- control-plane receipts that answer "why did this agent run this way?";
- RACI/source/effective/recorded views for governance state;
- visible escalation/blocker objects instead of vague "stuck" status.

### 2. Agent Identity And Track Record

GasTown treats worker identity as durable. A polecat has a name, actor identity, work history, mailbox, and capability record independent of any single terminal session.

Forge has roles and runtimes, but not yet a strong concept of an individual agent identity with a performance record. This is potentially valuable later, especially for model/provider comparison:

- Which runtime/model succeeds on which class of tasks?
- Which role seed produces reliable results?
- Which red agents catch real defects versus noise?
- Which implementation agent tends to need rework?

Forge should probably express this as **agent execution history** rather than named worker personas. The dashboard can answer capability/reliability questions without introducing memorable mascot names or manual assignment rituals.

### 3. Worktree And Merge Queue Design

GasTown is far ahead of Forge in native worktree thinking. Its polecat model separates:

- identity: long-lived agent record;
- sandbox: git worktree and branch;
- session: ephemeral agent CLI/tmux context.

That separation is useful for Forge's FG-345/FG-351 thread. It confirms the value of thinking separately about task identity, working tree, container/session, branch, and merge result.

GasTown's Refinery also has a real merge queue model: MRs target branches, gates run, conflicts get handled, batches can be built and bisected, and integration branches collect epic work before landing to main. Forge's current worktree design should borrow the shape, but not the whole implementation.

The key lesson for Forge: worktrees alone are not the safety feature. The safety feature is the combination of worktree isolation, merge conflict surfacing, post-merge validation, visible branch/merge state, and cleanup/reconcile.

### 4. Convoys As Human Attention Objects

Convoys are one of GasTown's best product ideas. They give a durable object for "this batch of related work" that can span multiple tasks and repos. The convoy is the thing you check, not every worker process.

Forge's nearest equivalents are runs, workflows, backlog epics/stories, and possibly future worktree fan-out groups. Forge should not add a "convoy" noun, but should borrow the attention model:

- every run should have a compact progress object;
- fan-out/fan-in should have a visible group node;
- blocked children should roll up clearly;
- dashboards should show "ready but not dispatched", "running", "awaiting gate", "blocked", and "landed/complete" at the group level.

This reinforces the value of the Run Map and Backlog Viewer stories under FG-291.

### 5. Scheduler / Backpressure

GasTown has a scheduler that can defer dispatch, respect a max concurrent worker count, preserve the work bead, and store dispatch state separately in ephemeral scheduling beads.

Forge has already felt provider auth, rate limit, and runtime pressure. A Forge scheduler should be dashboard-first and concept-light:

- queue tasks when capacity is exhausted;
- show exactly why each task is queued;
- make limits explicit per runtime/provider/model;
- avoid modifying the source task just to express queue state;
- record dispatch attempts and failures as receipts/events.

GasTown's "separate scheduling context object" is the cleanest part to borrow.

### 6. Mail, Handoff, And Escalation

GasTown's mail protocol is a structured inter-agent messaging layer. It covers completion, merge readiness, merge failures, rework, recovery, help, and handoff. Escalation is severity-routed and can re-escalate stale items.

Forge already has events, results, gates, notifications, and orchestrator-mediated handoff. The lesson is not "add mail." The useful pattern is **typed coordination messages**:

- `task.completed`
- `review.blocked`
- `merge.conflicted`
- `route.resolved`
- `receipt.recorded`
- `escalation.opened`
- `handoff.created`

These should be durable, dashboard-readable, and associated with exact actors and artifacts. Human-visible escalation should become its own dashboard surface eventually.

### 7. Provider Integration Tiers

GasTown's provider integration docs are pragmatic: any CLI can be tmux-driven at the lowest tier, then richer presets/hooks/deep integration add lifecycle and context features.

Forge is taking a different path: Dockerized agents, runtime YAML, model policy, provider abstraction, auth profiles, and structured outputs. Forge's approach is more controlled and testable. GasTown's tiered framing is still useful for explaining capability levels:

- runtime launches at all;
- runtime supports non-interactive structured output;
- runtime supports usage accounting;
- runtime supports auth/profile isolation;
- runtime supports hooks/tool guards;
- runtime supports resume/handoff.

This could become part of Forge's provider/runtime compatibility matrix.

## GasTown's Main Risks

### 1. Vocabulary Load

GasTown's naming system is internally consistent, but it is a lot: Mayor, Deacon, Witness, Dog, Polecat, Rig, Town, Hook, Convoy, Bead, Molecule, Wisp, Sling, Nudge, Seance, Refinery, Wasteland, and more.

This is a real product risk, but the risk is not human-friendly naming itself. Some GasTown names reduce cognitive load because they map to familiar responsibilities: Mayor as coordinator, Witness as observer/verifier, Refinery as the place where raw work is prepared for landing, Convoy as grouped movement. The risk is unbounded metaphor: when every operational detail gets a themed noun, the human must learn both the system and the metaphor.

Forge should avoid copying the vocabulary system, not the instinct to make roles humane. Our current work on reducing control-plane complexity points toward fewer underlying nouns, explicit source/effective/recorded views, dashboard explanations, and one small invariants document. Human labels can sit above that machine contract.

### 2. Heavy Operational Dependencies

GasTown expects a substantial local stack: Go, Git, Dolt, Beads, sqlite3, tmux, and multiple agent CLIs. Dolt/Beads give it a powerful distributed ledger story, but they also create another operational substrate to diagnose.

Forge is simpler here. SQLite as the blackboard is boring in a good way. Docker containers are a heavier runtime boundary than tmux, but they are easier to reason about for file isolation, auth injection, and red-agent read-only mounts.

### 3. CLI-First Human Experience

GasTown has a web dashboard, but the main docs and commands are still CLI-heavy: sling, convoy, mail, mq, scheduler, prime, done, hook, etc.

That does not match Forge's product direction. You have been explicit that humans should rarely run CLI commands; the orchestrator should operate the system, and information gaps should surface in the dashboard. Forge should continue treating CLI as the control-plane API and dashboard as the human-facing cockpit.

### 4. Autonomy Bias

GasTown's propulsion principle pushes agents to keep moving when work is attached. That is a good fit for a system aiming at high autonomous throughput, but it can be dangerous when requirements, policy, or trust boundaries are unclear.

Forge should be more conservative. The better fit is: move autonomously only when the route, task contract, artifact, gate, and receipts are clear. Otherwise surface the uncertainty, do not bury it inside a worker session.

### 5. State Surface Area

GasTown stores important state across Beads, Dolt SQL, git branches, worktrees, tmux sessions, settings files, hook directories, mail messages, convoys, and runtime-specific agent logs. It has doctor/cleanup/recovery commands because it needs them.

Forge also has layered state, but we should be careful not to add more storage planes. Before adding worktrees or additional queues, we should make state provenance visible in the dashboard.

## What Forge Already Does Better

### 1. Stronger Isolation Boundary

Forge agents run in ephemeral Docker containers. Reds can mount the project read-only. Auth can be injected by profile. Runtime dependencies can be baked into images. This is easier to audit than terminal sessions operating directly in worktrees.

GasTown's tmux approach is flexible and agent-agnostic, but process control and filesystem trust are less explicit.

### 2. Governance And Routing

Forge's RACI/routing policy work is a stronger governance model than GasTown's role vocabulary. Forge is trying to make responsibility, consultation, evidence, project overrides, and effective routing explicit.

The weakness is visibility: the policy stack is hard to hold in a human head. That is exactly why the RACI Workbench, control-plane sources view, and receipts matter.

### 3. Red-Agent Review As A First-Class Gate

Forge has invested heavily in reds, verdict schemas, failure kinds, gate decisions, and review loops. GasTown has validation and merge gates, but Forge's adversarial review model is sharper as a trust boundary for agent output.

Forge should preserve that advantage when adding worktrees. A worktree merge that passes text conflict checks is not enough; reds and post-merge gates need to review the artifact that will actually land.

### 4. Simpler Core Data Model

Forge's run/task/event model is easier to reason about than GasTown's full town model. The cost is that Forge needs better dashboard projections. The advantage is that the underlying nouns can stay small.

### 5. Human-Centered Direction

Forge's recent backlog direction is right: Run Map, control-plane source view, receipts, RACI Workbench, backlog viewer, and invariants doc. Those are the surfaces a human needs to understand the system without becoming a CLI operator.

GasTown shows what happens when the system is powerful but the operational model becomes the product. Forge should make the dashboard the product.

## Human Layer And Machine Contract

The RACI/routing split is the best model for Forge naming. RACI is the human-facing responsibility layer. Routing policy is the machine contract. We do not hide the routing policy, but a human should be able to operate from RACI most of the time.

The same pattern should apply across Forge:

- **Human layer:** RACI, role names, dashboard labels, backlog language, Coordinator, Builder, Reviewer, Gate.
- **Machine layer:** routing policy, runtime YAML, workflow YAML, task manifests, receipts, events, failure kinds.
- **Audit bridge:** every human-friendly concept links to the machine object it resolved into.

Design rule: show the human concept first, with the machine resolution one click away.

Example: the dashboard can say "Reviewer blocked this task" while the receipt records `role=red-team-specialist`, runtime, model alias, resolved model, route source, project override, seed, constraints, mounted artifact, verdict, and receipt id.

This gives Forge the good part of GasTown's humane naming without making the metaphor the control plane.

## What Forge Should Learn

### Near-Term

1. **Finish dashboard visibility before worktree rollout.** GasTown confirms that worktrees create more state to inspect. Forge should not land worktree complexity before the dashboard can explain active branches/worktrees, merge state, cleanup state, and conflicts.

2. **Keep FG-345/FG-351 scoped.** Borrow GasTown's identity/sandbox/session separation, but do not copy persistent worker pools yet. First cut should be task-scoped worktrees, explicit cleanup, recorded worktree path, visible merge conflict failure, and macOS-only if Linux dependency state is unresolved.

3. **Add a group-level run/fan-out object in the dashboard.** GasTown convoys are valuable because they are attention objects. Forge run map should show groups and blockers, not just a list of task rows.

4. **Make receipts central.** GasTown's durable ledger validates the direction of FG-350. Forge receipts should answer: what source config was read, what effective route/model/runtime was chosen, what project override applied, what artifact was mounted, and what gate/review decided.

5. **Model queued capacity as separate state.** If Forge adds scheduling/backpressure, use a separate queue/dispatch-attempt record instead of mutating the task contract.

### Medium-Term

6. **Track agent/runtime performance.** Add dashboard/reporting views for model/runtime/role success rates, red precision, failure kinds, and retry outcomes. This captures GasTown's "agent CV" value without creating named worker lore.

7. **Create typed escalation objects.** A task can fail, block, or escalate. Escalation should be queryable and visible with severity, owner, source task, and stale age.

8. **Define runtime capability tiers.** Borrow GasTown's provider integration maturity ladder, but express it in Forge terms: launch, structured output, usage, auth, hooks/tool guard, resume, browser, filesystem mode.

9. **Consider integration branches only after task worktrees prove out.** GasTown's integration branch model is compelling for epic-scale work, but it is a second-order feature. Forge should first prove single-task and deterministic fan-out merge semantics with visible post-merge validation.

## What Forge Should Not Copy

1. **Do not copy an unbounded vocabulary model.** Forge needs fewer underlying nouns, not more. Human-friendly labels are good when they map to real responsibilities and resolve to inspectable machine state.

2. **Do not add Dolt/Beads-class dependencies unless federation becomes a real requirement.** SQLite plus git-backed backlog files are sufficient for now.

3. **Do not make humans drive a richer CLI.** Every new control-plane feature should have a dashboard explanation path.

4. **Do not adopt persistent worker pools yet.** Persistent identity is useful; persistent mutable sandboxes are operationally expensive. Start task-scoped.

5. **Do not treat worktree merging as a quality gate.** It catches textual conflicts. It does not catch semantic breakage.

6. **Do not adopt fail-open scheduling/gating behavior casually.** GasTown sometimes chooses progress over conservative blocking. Forge's trust model should be stricter unless the dashboard makes the risk explicit.

## Implications For Current Forge Backlog

### FG-350 Control-Plane Receipts

GasTown validates this direction. Durable records of what actually happened are the antidote to layered control-plane confusion. Receipts should become the primary debugging artifact for "why did Forge do that?"

### FG-351 / FG-345 Worktrees

GasTown makes me more confident that worktrees are strategically useful, but also more cautious about timing. The right order is:

1. dashboard/control-plane visibility;
2. task-scoped worktree creation and cleanup;
3. merge conflict failure kind;
4. red review of frozen/merged artifact;
5. post-merge integration gate;
6. only later, integration branches and persistent pools.

### FG-348 Run Map

GasTown convoys are the clearest evidence that Forge needs this. A workflow system needs a visual progress object that rolls up fan-out, waiting, blocked, review, and landed states.

### FG-359 RACI Workbench

GasTown's property layers and role system show the same category of problem from another angle: layered policy is hard to reason about unless the tool shows source, override, effective value, and actor. Forge's SOURCE / DERIVED / EFFECTIVE / RECORDED vocabulary is the right simplification.

### FG-363 Backlog Viewer

GasTown's Beads-first model makes backlog/work objects central. Forge should close the dashboard gap here. Humans should be able to browse backlog items, see parent/child relationships, inspect notes, and connect backlog items to runs without using CLI commands.

## Bottom Line

GasTown is more ambitious as an agent operating environment. Forge is more promising as a controllable, inspectable personal orchestration system.

The most important thing to borrow is not any one feature. It is the discipline that orchestration state must be durable, queryable, attributed, and recoverable. The most important thing to avoid is making the human learn an ever-expanding operational mythology.

For Forge, the winning path is: fewer nouns, stronger receipts, dashboard-first visibility, conservative trust boundaries, and worktrees only after the system can explain them.

## Sources Inspected

- [GasTown repository](https://github.com/gastownhall/gastown)
- [README](https://github.com/gastownhall/gastown/blob/main/README.md)
- [Overview](https://github.com/gastownhall/gastown/blob/main/docs/overview.md)
- [Glossary](https://github.com/gastownhall/gastown/blob/main/docs/glossary.md)
- [Architecture design](https://github.com/gastownhall/gastown/blob/main/docs/design/architecture.md)
- [Polecat lifecycle](https://github.com/gastownhall/gastown/blob/main/docs/concepts/polecat-lifecycle.md)
- [Integration branches](https://github.com/gastownhall/gastown/blob/main/docs/concepts/integration-branches.md)
- [Scheduler design](https://github.com/gastownhall/gastown/blob/main/docs/design/scheduler.md)
- [Escalation protocol](https://github.com/gastownhall/gastown/blob/main/docs/design/escalation.md)
- [Mail protocol](https://github.com/gastownhall/gastown/blob/main/docs/design/mail-protocol.md)
- [Property layers](https://github.com/gastownhall/gastown/blob/main/docs/design/property-layers.md)
- [Agent provider integration](https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md)
- [Gas City crew specialization design](https://github.com/gastownhall/gastown/blob/main/docs/gas-city/crew-specialization-design.md)
- [Why these features](https://github.com/gastownhall/gastown/blob/main/docs/why-these-features.md)
- Representative implementation files in the local clone: `internal/cmd/dashboard.go`, `internal/cmd/done.go`, `internal/cmd/convoy_stage.go`, `internal/convoy/operations.go`, `internal/refinery/batch.go`, `internal/refinery/engineer.go`, `internal/beads/integration.go`.
