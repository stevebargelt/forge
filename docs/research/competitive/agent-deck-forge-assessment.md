# Agent Deck Assessment Compared to Forge

Date: 2026-07-17

Project: [`asheshgoplani/agent-deck`](https://github.com/asheshgoplani/agent-deck)

Snapshot inspected: [`4d3a898537d97534e9c960f56b9d62e227a2c873`](https://github.com/asheshgoplani/agent-deck/tree/4d3a898537d97534e9c960f56b9d62e227a2c873), current `origin/main` at the time of review. The source identifies itself as version 1.10.9.

This is the tmux-centered **Agent Deck**, not the separately maintained [`puritysb/AgentDeck`](https://github.com/puritysb/AgentDeck) multi-device control surface. The two are compared briefly in [`agentdeck-forge-assessment.md`](agentdeck-forge-assessment.md); this document examines the tmux manager in depth.

## Executive Take

Agent Deck is a serious local operating environment for interactive coding agents. Calling it a tmux manager is accurate but incomplete. It combines:

- a Go/Bubble Tea terminal UI;
- tmux session creation, persistence, attach, restart, and recovery;
- session identity and status adapters for multiple agent CLIs;
- Git worktrees and optional Docker sandboxes;
- session forking and parent/child relationships;
- a per-profile SQLite state store;
- group-level concurrency queues;
- cost, MCP, skill, and provider-account management;
- a persistent Claude or Codex Conductor;
- durable child-completion delivery;
- watchers, remote messaging, and a watchdog.

It is closer to Forge than the surface-level product description suggests. It has independently encountered many of the same failure classes: shell-owned work dying, session identity loss, stale status inference, a busy parent missing child completion, duplicate notifications, incompatible concurrent processes, unsafe worktree cleanup, and agents silently waiting for attention.

The most important conclusion is not that Forge should adopt Agent Deck. It is that Agent Deck validates several Forge directions while showing the danger of owning too many adjacent systems at once.

Recommended disposition:

1. Use Agent Deck as a strong product and implementation reference.
2. Consider it for direct, non-Forge Claude/Codex sessions after a bounded scratch trial.
3. Do not let it manage Forge-owned workers, worktrees, containers, task status, or continuation.
4. Do not replace Forge's orchestrator with Agent Deck's Conductor.
5. Borrow its session navigator, attention inbox, recovery UX, group concurrency, and project-first organization.
6. Keep Forge's durable task, evidence, review, publication, and campaign state authoritative.

## Product Model

Agent Deck's primary object is an interactive agent session. A session has a stable Agent Deck ID, tool type, project path, group, tmux identity, status, optional parent, provider-specific conversation ID, optional worktree, optional Docker container, and launch configuration.

The ordinary flow is:

```text
operator or Conductor
        |
        v
create/launch Agent Deck session
        |
        +--> optional worktree
        +--> optional Docker sandbox
        |
        v
tmux owns agent CLI process
        |
        +--> hooks and tmux observations update session status
        +--> provider session ID is persisted for resume/fork
        |
        v
session waits, exits, errors, or asserts completion
        |
        v
parent inbox / Conductor attention
```

This is a coherent model for a human managing many open conversations. It is not a complete software-delivery contract. A session can be complete while its code is uncommitted, unreviewed, untested, unpublished, or inconsistent with the ticket that motivated it.

## Architecture and State

### Process and UI architecture

Verified fact: the main application is a Go CLI and Bubble Tea TUI. tmux owns the actual interactive processes. A local web UI is also available. Agent Deck supports macOS, Linux, and WSL. See the [README](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/README.md).

The source tree is large. At the inspected snapshot it contains approximately:

- 416 non-test Go files and 160,101 non-test Go lines;
- 829 Go test files and 187,879 Go test lines.

These counts are not a quality judgment. They demonstrate that Agent Deck is a broad platform rather than a thin tmux wrapper. They are also a warning: matching its complete feature surface would materially increase Forge's complexity.

### Canonical session database

Verified fact: each profile has a canonical SQLite database at:

```text
~/.agent-deck/profiles/<profile>/state.db
```

The database uses WAL, a busy timeout, foreign keys, transactional migrations, and schema versioning. It stores instances, groups, process heartbeats, recent sessions, cost events, watchers, and watcher events. See the [state database schema](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/docs/internal/state-db-schema.md).

The instance record includes:

- Agent Deck session ID and display title;
- project and group;
- command, wrapper, and tool family;
- last-known status;
- tmux session and socket;
- parent session;
- conductor marker;
- worktree path, repository, and branch;
- provider conversation IDs and launch options;
- Docker, SSH, MCP, plugin, and channel metadata.

This is a meaningful source of truth for Agent Deck's domain: registered interactive sessions. It is not evidence that an external task's acceptance criteria were met.

### Session identity

Verified fact: Agent Deck treats provider conversation identity carefully. Binding and rebinding come from tmux environment, hook payloads, or hook sidecars. Disk scans are explicitly non-authoritative for identity binding. Decisions are appended to a lifecycle log. See the [session-ID lifecycle contract](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/docs/session-id-lifecycle.md).

This separation is excellent:

```text
Agent Deck session ID       identifies the managed terminal/session object
provider conversation ID   identifies the Claude/Codex/etc. conversation
tmux identity              identifies the live process container
project/worktree identity  identifies the filesystem context
```

Forge has the same conceptual need across task, attempt, launch, container, run, worktree, branch, provider session, and campaign. Agent Deck is a useful example of making those identities visible instead of collapsing them into a pane name.

### Session status

Verified fact: status is derived from agent hooks when available, with tmux and pane-title fallback on some surfaces. The shared derivation recognizes tool-specific freshness windows and maps observations into running, waiting, idle, error, stopped, and queued states. See the [status derivation package](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/internal/sessionstatus/sessionstatus.go).

This is a good attention model. It is not a task-state model. Its evidence answers questions such as:

- Is the process alive?
- Is the agent likely working?
- Is it waiting for input?
- Did a hook recently report an error or stop?

It cannot alone answer:

- Did the requested change land in the intended checkout?
- Did required tests and reviews pass?
- Was the candidate published to the target branch?
- Is an unsettled publication still recoverable?
- May a campaign advance to the next item?

Agent Deck's own code recognizes this distinction in places, but product language such as “done” can still be read more strongly than the evidence supports.

## Session Persistence and Recovery

Agent Deck has done unusually serious work on long-running terminal persistence.

Verified fact: on Linux/systemd it can place tmux under a user scope so SSH logout does not kill it with the login session's cgroup. It persists provider conversation IDs and resumes conversations after stop, error, SIGKILL, or restart. The behavior is guarded by dedicated tests and a host verification script. See the [session persistence specification](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/docs/SESSION-PERSISTENCE-SPEC.md).

This is directly relevant to Forge's operational experience. It reinforces three principles:

1. A durable record is not enough if the process owner dies with the submitting shell.
2. Process identity and provider-conversation identity must be persisted independently.
3. Recovery needs an executable verification path, not just a code assertion.

Agent Deck also includes a reviver for dead control pipes and an optional separate watchdog for higher-level session health. That separation is healthy: transport/process repair is not presented as proof that the task succeeded.

## Worktrees and Docker

### Worktrees

Agent Deck can create worktrees, create branches, copy selected ignored files, run setup and destruction scripts, finish and merge branches, and clean orphaned worktrees. It also supports session forking into new worktrees.

The user experience is strong. The TUI makes the worktree part of session creation rather than an operator-side Git ritual.

The safety contract is intentionally more permissive than Forge's in at least two places:

- a failed worktree setup script leaves the worktree in place and the session proceeds with a warning;
- a failed destruction script does not prevent worktree removal.

That is reasonable for an interactive session manager. Forge should not copy it for prerequisites or cleanup that protect durable task evidence. Forge's clone/worktree readiness must fail closed when missing dependencies would invalidate verification, and cleanup must respect publication and recovery ownership.

### Docker

Verified fact: Agent Deck offers one optional container per session. It uses a read-only root filesystem, drops capabilities, prevents privilege escalation, applies a process limit, and does not mount the Docker socket. The project directory is mounted read-write. See the [sandbox reference](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/skills/agent-deck/references/sandbox.md).

It also copies or extracts host tool credentials into shared sandbox directories and mounts those directories into containers. This makes interactive use convenient, including on macOS where credentials may originate in Keychain.

The tradeoff differs from Forge's desired boundary:

- Agent Deck optimizes for “my existing authenticated agent works in the container.”
- Forge needs provider- and role-specific runtime policy, explicit credential provenance, reproducible image readiness, and durable container evidence.

Forge should not adopt Agent Deck's shared credential directories as a shortcut around its auth/runtime policy.

## Concurrency and Scheduling

Verified fact: groups have a `max_concurrent` value. A launch into a group at capacity is persisted as queued, and stopping a running session drains the next queued session. Newly created groups default to serial execution unless configured otherwise. See [group concurrency](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/internal/session/group_concurrency.go).

This is simple and useful backpressure. It solves a real machine-capacity problem without requiring a full workflow scheduler.

Forge should borrow the product shape:

- show queued work explicitly;
- name the capacity rule responsible;
- preserve FIFO or another declared ordering;
- separate queued state from failed state;
- automatically reconsider work when capacity is released.

Forge will need additional dimensions: provider quotas, model limits, Docker capacity, per-project mutation lanes, dependency order, and campaign gates. Agent Deck's group cap is a good primitive, not a complete Forge scheduler.

## Conductor

### What it is

Verified fact: a Conductor is a persistent Claude or Codex session in named tmux. It has a directory containing:

```text
CLAUDE.md
POLICY.md
LEARNINGS.md
state.json
task-log.md
```

It watches child sessions, auto-responds when its policy allows, escalates uncertain decisions, and can connect to Telegram, Slack, or Discord. A heartbeat is installed through systemd or launchd by default. See the [Conductor documentation](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/docs/conductor/README.md).

The Conductor is deliberately understandable: it is an agent with instructions, editable policy, accumulated learnings, a state summary, and an action log. This is approachable in a way Forge's workflow/RACI/model-policy stack often is not.

### Where it is strong

- It gives one human-facing session responsibility for a fleet.
- Its state and policy files are inspectable and editable.
- It separates auto-response rules from escalation rules.
- It can supervise sessions without forcing the operator to attach to every pane.
- It supports multiple independent conductors and profiles.
- It provides remote attention through ordinary messaging tools.

### Where it is weaker than Forge's intended contract

The Conductor's reasoning state remains LLM-maintained Markdown and JSON. Its `task-log.md` is free-form. Policy application is prompt-driven. The Conductor decides what to do after reading session observations and inbox messages.

Forge's core transitions should not depend on an LLM remembering to update a state file correctly. The Conductor pattern is suitable for attention, triage, and delegation. It is not a substitute for transactional task state, authoritative verdicts, publication evidence, or compare-and-set continuation.

The important product lesson is to give Forge's orchestrator an equally approachable attention and policy surface while keeping state transitions in Forge code and SQLite.

## Durable Child Completion

This is the most technically relevant subsystem for Forge.

### What Agent Deck has implemented

Agent Deck supports two completion shapes:

1. Persistent interactive sessions can print a structured completion sentinel in their final response. Hooks inspect the turn and persist the assertion.
2. One-shot workers can run under `agent-deck run-task`; the wrapper observes the kernel exit, writes a completion record, and delivers it to the parent.

The parent delivery path is more robust than a timer that checks pane output:

- the child completion is committed to a per-parent JSONL inbox;
- writes are flushed;
- a drain first stages records to an in-flight WAL;
- the inbox is then removed;
- a durable consumed-fingerprint ledger suppresses replayed effects;
- a crash during drain causes redelivery rather than loss;
- a Stop hook drains at a turn boundary;
- a heartbeat provides an idle-parent fallback;
- dead letters distinguish terminal delivery failures.

See the [task-worker implementation](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/internal/session/taskworker.go), [producer outbox](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/internal/session/inbox_outbox.go), and [consumer drain](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/internal/session/inbox_consumer.go).

This is a real durable attention-delivery mechanism. It is much stronger than “check again in 30 minutes.”

### What “exactly once” means here

Agent Deck describes the consumer as at-least-once delivery with exactly-once effects. In this subsystem, the effect is presenting or injecting a particular child-turn completion to the parent once, using a turn fingerprint.

Forge needs a stronger binding for continuation:

```text
source launch
+ consumer
+ current phase
+ expected prior state
+ structured next action
```

A completion message delivered once can still be applied to the wrong workflow phase if the consumer's durable state has moved. Forge's continuation claim must atomically bind the completion to the state transition it authorizes, then address the claim-to-dispatch crash window.

The two systems are solving related but different “exactly once” problems.

### Semantic completion remains weaker

For an interactive child, semantic completion depends on an agent-printed sentinel. For a one-shot worker, a zero exit without a sentinel is classified as successful completion.

That establishes process completion, not accepted software delivery. There is no built-in requirement that:

- the requested files exist in the authoritative project checkout;
- tests or host verification passed;
- an independent reviewer approved the result;
- the commit reached the intended branch;
- publication is settled;
- a backlog item can truthfully close.

Forge should borrow the durable delivery machinery, not the equivalence between worker exit and task acceptance.

## Watchers and Watchdog

Agent Deck's watcher framework uses a good “doorbell, not package” design. Adapters normalize external triggers and forward compact events; the Conductor fetches live state only when it decides the event matters. Built-in sources include webhook, GitHub, ntfy, and Slack paths. Events are deduplicated and logged. See the [watcher documentation](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/documentation/WATCHERS.md).

The optional watchdog is deliberately narrower than the Conductor. It can restart declared critical sessions, detect a missing messaging poller, and nudge a child that remains waiting with unchanged pane output. It has restart rate limits and a cascade guard. See the [watchdog documentation](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/documentation/WATCHDOG.md).

Forge lessons:

- external signals should wake reconciliation, not carry authoritative truth;
- health repair should be separate from task-state transitions;
- repeated restart/nudge behavior needs rate limits and a visible reason;
- an unchanged pane is an attention hint, never completion evidence;
- the parent should have a durable inbox, not rely on a monitor remembering to poll.

## Model, Provider, and Cost Management

Agent Deck can select a model for a session, keep separate Claude accounts/config directories by group or Conductor, attach MCP servers and skills, and aggregate cost data across sessions.

This is operator-friendly but less policy-oriented than Forge. Model choice is mainly explicit launch/session configuration. Forge's target is a resolvable policy chain based on role and activity, with visible source, overrides, profile, model, and blast radius.

Forge should borrow:

- a per-session display of the actual agent, account/profile, and model;
- group and project cost summaries;
- easy search across session history;
- explicit capability differences among agent tools.

Forge should retain:

- policy-driven selection;
- durable resolution provenance;
- preview of override blast radius;
- separation between orchestrator policy and worker policy;
- result-quality evidence before automatic policy adaptation.

## Direct Comparison

| Concern | Agent Deck | Forge |
| --- | --- | --- |
| Primary object | Interactive session | Task/run/campaign and publication attempt |
| Human navigation | Strong TUI, search, groups, attach | CLI and growing dashboard; weaker session UX |
| Process owner | tmux, optionally Docker | tmux for host launches; Docker for task agents |
| Durable store | Per-profile SQLite plus runtime files | SQLite plus launch, backlog, result, and Git evidence |
| Status truth | Hooks + tmux/process observations | Persisted workflow/task state plus process/container evidence |
| Parent wake | Durable inbox, Stop hook, heartbeat | Durable continuation work under FG-561 |
| Semantic completion | Sentinel or one-shot exit | Structured result, gates, review, verification, publication |
| Continuation | Conductor reads completion and acts | Planned atomic claim bound to workflow state |
| Worktrees | First-class interactive UX | Stricter task isolation/publication lifecycle |
| Containers | Optional convenience sandbox | Declared execution environment and evidence source |
| Concurrency | Per-group caps and FIFO queue | Workflow/campaign ordering plus emerging capacity needs |
| Model choice | Explicit per-session/group configuration | Role/activity policy resolution and overrides |
| Review | Agent/Conductor can be prompted to review | Explicit reviewer roles, verdicts, review-loop, trust gates |
| Delivery/publication | Outside core session model | Core acceptance and recovery concern |
| Remote control | Telegram, Slack, Discord | Not a core Forge surface today |

## Where Agent Deck Is Better Today

### Operator ergonomics

Agent Deck makes a fleet of sessions legible. Forge still exposes too much internal launch/task naming and too little project-first navigation.

### Attach and resume

Finding and resuming the right live conversation is a first-class action rather than a forensic exercise.

### Attention management

Waiting sessions, parent/child relationships, completion inboxes, remote escalation, and a tmux notification bar are concrete product surfaces.

### Session lifecycle recovery

It has explicit contracts for tmux survival, provider conversation IDs, restart, reviver behavior, and human-verifiable persistence.

### Broad agent support

Agent Deck embraces interactive differences among Claude, Codex, Gemini, OpenCode, and other tools. Forge has stronger runtime policy but a less polished cross-agent operator surface.

## Where Forge Is Stronger

### Work is more than a session

Forge models the intended work, execution phase, agent role, task package, evidence, and workflow status independently of the process running it.

### Acceptance and review are explicit

Forge has structured results, reviewer authority, red findings, review-loop rounds, host verification, and truth gates. These are not inferred from a child saying it is done.

### Publication is modeled

Forge records candidate commits, target refs, publication attempts, unsettled recovery states, and campaign consequences. Agent Deck generally hands Git delivery back to the user or session.

### Failure vocabulary is richer

Forge distinguishes auth, infrastructure, cancellation, persistence, publication, review, and other failure kinds. Agent Deck's high-level session states are designed for attention, not delivery forensics.

### Campaigns and dependencies are durable

Forge can plan, approve, drive, pause, resume, reconcile, and report multi-ticket campaigns. Agent Deck's Conductor can coordinate many sessions but does so through prompt policy and its own working memory.

## How You Could Use Agent Deck

### Good current fit

Agent Deck could organize standalone interactive sessions such as:

- a dashboard Codex session;
- a foundation-planning Codex or Claude session;
- research or design conversations outside Forge execution;
- experiments in scratch repositories;
- long-lived conversations you want to locate and resume easily.

This would address the “which terminal had that work?” problem without changing Forge.

### Poor current fit

Do not initially use Agent Deck to:

- launch or restart Forge Docker task agents;
- create or clean Forge-owned worktrees;
- classify Forge tasks as complete;
- supervise Forge campaigns;
- merge branches on Forge's behalf;
- replace `forge launch wait` or the durable continuation primitive;
- select models outside Forge's model policy for Forge work.

### `forge claude` caveat

Launching Claude directly through Agent Deck would bypass parts of `forge claude`: project orientation checks, environment shaping, model-policy work, orchestrator run/task recording, and usage capture.

Launching `forge claude` as a generic custom command would preserve Forge behavior but may cause Agent Deck to treat it as a shell rather than a fully hook-capable Claude session. That needs a deliberate adapter or supported custom-tool definition before it can be recommended.

The clean future shape would be an Agent Deck tool adapter whose executable is `forge claude`, whose lifecycle capabilities are declared accurately, and whose detailed task state is read from Forge rather than inferred from its tmux pane.

## Integration Options

### Option 1: no integration, borrow product concepts

Recommendation: do this now.

Use the research to improve Forge's dashboard, session attachment, attention inbox, queued-state visibility, and project-first grouping.

### Option 2: standalone personal use

Recommendation: reasonable after a scratch trial.

Let Agent Deck own ad hoc sessions that Forge does not know about. Keep a hard namespace and lifecycle boundary.

### Option 3: read-only Forge projection in Agent Deck

Recommendation: plausible later.

Expose Forge projects, orchestrators, launches, tasks, and attention states through a read-only API or adapter. Agent Deck displays and attaches; all mutations route back through Forge commands.

```text
Forge durable state
        |
        v
read-only projection
        |
        v
Agent Deck row / status / attach target
```

### Option 4: Agent Deck owns Forge execution

Recommendation: reject.

This would create two databases and two lifecycle owners for the same tmux sessions, worktrees, containers, and agents. Recovery behavior would become ambiguous precisely where Forge has spent the most effort making it explicit.

### Option 5: replace Forge with Agent Deck

Recommendation: reject unless Forge's product goal is deliberately reduced to interactive session management.

Agent Deck would provide a much better immediate session UX. Replacing Forge would discard the differentiated work on accepted task contracts, independent review, publication recovery, policy routing, and campaigns.

## Concepts Forge Should Borrow

### 1. Project-first session navigator

The project should be the stable object. Branch, worktree, run, agent, and session should appear as subordinate information. This is directly applicable to the Forge dashboard's Projects view.

### 2. One-keystroke attach

Every live orchestrator or human-facing session should have a clear attach action. Internal tmux names should be evidence, not the primary label.

### 3. Durable attention inbox

Completion and blocked-state notifications should accumulate durably and be drainable by the orchestrator at a safe turn boundary. Forge's implementation must bind each notification to its workflow state before advancing.

### 4. Stop-hook plus heartbeat fallback

The synchronous turn-boundary drain handles a busy parent; the heartbeat handles an idle one. This is a useful wake pattern as long as reconciliation remains authoritative.

### 5. Group concurrency with visible queueing

Simple, explainable backpressure is better than launching everything and discovering the host limit through OOM or provider failures.

### 6. Session identity lifecycle log

Binding, rebinding, and rejection of provider session identity should be auditable. Forge launch and provider records would benefit from similar visibility.

### 7. Watchdog scoped to health

Automatically repair process/session health only where explicitly authorized. Never let restart machinery manufacture successful task state.

### 8. Worktree readiness as a first-class setup phase

Agent Deck makes project setup visible. Forge should take the stricter version: dependencies and required tools must be provisioned and verified before history-dependent or test-dependent work dispatches.

### 9. Cost as an operator surface

Cost by project, group, model, and session should be easy to inspect. Forge can add quality and delivery outcomes to make those costs actionable.

### 10. Friendly policy files

Agent Deck's editable `POLICY.md` is more approachable than resolving multiple machine policy files mentally. Forge should provide equivalent rendered explanations and previews without making prose the runtime authority.

## What Forge Should Not Copy

- Do not treat tmux status as task truth.
- Do not accept agent-printed completion as delivery acceptance.
- Do not create a second state database for Forge-owned agents.
- Do not let another tool own Forge worktree or container cleanup.
- Do not share broad host credential state into workers merely for convenience.
- Do not proceed after required setup fails.
- Do not make free-form Markdown or LLM-updated JSON the authoritative workflow state.
- Do not add every adjacent operator feature to Forge simply because Agent Deck has it.
- Do not reproduce Agent Deck's product breadth; its 160,000-line non-test Go surface is a caution as well as an accomplishment.

## Bounded Trial Plan

If Agent Deck is trialed, use a scratch repository and do not involve Forge-owned work.

### Scope

- install a pinned release rather than `latest`;
- create one ordinary Codex or Claude session;
- create one group;
- test search, attach, detach, status, stop, and resume;
- optionally test a worktree only inside the scratch repository;
- inspect the files and database it creates;
- uninstall or retain only after reviewing the mutations.

### Disable or avoid initially

- Conductor;
- heartbeat services;
- watchdog;
- Telegram, Slack, Discord, and ntfy;
- MCP and skill mutation;
- Docker credential sharing;
- worktree finish/merge automation;
- sessions in the Forge repository;
- any attempt to discover or manage Forge task tmux sessions.

### Success criteria

- session navigation is materially better than raw tmux;
- resume preserves the intended conversation;
- status is accurate enough to direct human attention;
- project/group organization remains useful beyond two sessions;
- all created services, files, hooks, sessions, and state are understood;
- no Forge configuration or durable state changes.

## Backlog Implications

This research does not justify a new integration epic yet.

It does strengthen existing or already-discussed directions:

- project-first dashboard identity;
- reliable orchestrator attention and continuation;
- clone/worktree readiness;
- explicit queued/capacity state;
- session attachment and recovery UX;
- model-resolution explanations;
- durable context/handoff surfaces;
- cost and outcome reporting.

Any future Agent Deck integration ticket should require an authority matrix before implementation:

| Resource | Owner | Other system's access |
| --- | --- | --- |
| Forge task/run/campaign | Forge | read-only |
| Forge task worktree | Forge | none or read-only |
| Forge task container | Forge | none |
| Forge publication/recovery | Forge | none |
| Ad hoc Agent Deck session | Agent Deck | not tracked by Forge unless imported explicitly |
| Human attach UI | Either surface | no state mutation without routed command |

Without that matrix, integration should not begin.

## Final Assessment

Agent Deck is one of the strongest examples of a local interactive-agent command center. Its session UX, persistence work, attention delivery, and recovery mechanisms are highly relevant to Forge. It has moved beyond pane polling in important areas and deserves to be evaluated as a real neighboring system, not a cosmetic tmux tool.

Forge's advantage is that it models delivery correctness beyond the session. The systems can coexist only if that boundary remains clear:

```text
Agent Deck answers: Where is the agent, what is it doing, and does it need me?
Forge answers: What work was authorized, what evidence exists, did it land, and may the system advance?
```

The best near-term outcome is to borrow Agent Deck's operator experience while completing Forge's durable orchestration foundation. Direct integration can wait until Forge exposes a stable read-only projection and the two systems' ownership is explicit.

Agent Deck is [MIT licensed](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/LICENSE).

## Primary Sources

- [Repository and README](https://github.com/asheshgoplani/agent-deck/tree/4d3a898537d97534e9c960f56b9d62e227a2c873)
- [State database schema](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/docs/internal/state-db-schema.md)
- [Session-ID lifecycle](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/docs/session-id-lifecycle.md)
- [Session persistence specification](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/docs/SESSION-PERSISTENCE-SPEC.md)
- [Conductor documentation](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/docs/conductor/README.md)
- [Task-worker completion](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/internal/session/taskworker.go)
- [Durable inbox consumer](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/internal/session/inbox_consumer.go)
- [Watcher framework](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/documentation/WATCHERS.md)
- [Watchdog](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/documentation/WATCHDOG.md)
- [Docker sandbox](https://github.com/asheshgoplani/agent-deck/blob/4d3a898537d97534e9c960f56b9d62e227a2c873/skills/agent-deck/references/sandbox.md)
