# AgentDeck and agent-deck Assessment Compared to Forge

Date: 2026-07-17

Repositories reviewed:

- [`puritysb/AgentDeck`](https://github.com/puritysb/AgentDeck) — multi-device session observation and control.
- [`asheshgoplani/agent-deck`](https://github.com/asheshgoplani/agent-deck) — tmux-based AI-agent session manager.

The names are confusingly similar, but the products solve different problems. This assessment keeps them separate and distinguishes verified facts, inferences, and recommendations.

## Executive Recommendation

Neither project should become Forge's orchestration authority.

`puritysb/AgentDeck` is the better candidate for a bounded, read-only Forge integration experiment. Its adapter and multi-surface architecture could make Forge activity visible on a terminal UI, phone, Stream Deck, or small status display. Forge must remain the source of truth, and the experiment should consume a replayable Forge projection rather than infer durable state from PTYs.

`asheshgoplani/agent-deck` is the stronger product and UX reference for managing many interactive coding sessions. Its tmux TUI, grouping, attach/resume flow, worktree UX, session forking, cost view, and conductor attention queue are directly relevant to Forge's operator experience. It is a poor candidate to place underneath Forge because it wants to own many of the same resources: tmux sessions, worktrees, Docker sandboxes, agent lifecycle, status, and supervisory automation. Layering the two without a hard authority boundary would create two competing control planes.

Recommended disposition:

1. Do not create a Forge implementation epic from this research yet.
2. Consider a small `puritysb/AgentDeck` monitor-only trial for one host-side interactive orchestrator.
3. Treat `asheshgoplani/agent-deck` primarily as a product-pattern reference. If trialed, use it only for ad hoc interactive sessions outside Forge-owned task execution.
4. Borrow the best concepts into Forge's dashboard and operator surfaces while preserving Forge SQLite, launch records, task state, gates, and continuation claims as authoritative.

## The Three Systems at a Glance

| System | Primary object | What it is good at | What it does not establish |
| --- | --- | --- | --- |
| `puritysb/AgentDeck` | Observed agent session | Hooks-first live state, approvals, timelines, many display/control surfaces | Durable task/run/campaign truth or transactional continuation |
| `asheshgoplani/agent-deck` | tmux-backed interactive session | Fleet navigation, attach/resume, groups, worktrees, forks, conductor supervision | Forge's acceptance, publication, review, and exactly-once semantics |
| Forge | Durable task/run/campaign | Policy routing, isolated execution, gates, review, publication, recovery, campaign state | A polished interactive session command center across arbitrary agents |

## `puritysb/AgentDeck`

### What It Is

Verified fact: AgentDeck is a local daemon and a family of clients for observing and controlling AI coding sessions. It supports Claude Code, Codex, and OpenCode and projects session state onto a TUI, macOS/iOS/Android applications, Stream Deck, and other small-display surfaces. Its daemon normally listens on port 9120; per-session bridges use subsequent ports. See its [README](https://github.com/puritysb/AgentDeck#readme), [architecture](https://github.com/puritysb/AgentDeck/blob/master/docs/architecture.md), and [daemon documentation](https://github.com/puritysb/AgentDeck/blob/master/docs/daemon.md).

Verified fact: its preferred observation mechanism is agent lifecycle hooks. PTY parsing is a fallback. The shared adapter contract normalizes events and capabilities across supported agents; this is more disciplined than treating every terminal as an equivalent byte stream. See the [adapter interface](https://github.com/puritysb/AgentDeck/blob/master/shared/src/adapter.ts) and [protocol](https://github.com/puritysb/AgentDeck/blob/master/docs/protocol.md).

Verified fact: the daemon maintains session registration, liveness, cached state, timelines, and health probing. Data includes `sessions.json`, a timeline store, and an APME SQLite database. This is meaningful operational persistence, but it is session-observation state rather than Forge's task state. See the [session registry](https://github.com/puritysb/AgentDeck/blob/master/bridge/src/session-registry.ts), [session aggregator](https://github.com/puritysb/AgentDeck/blob/master/bridge/src/session-aggregator.ts), [timeline store](https://github.com/puritysb/AgentDeck/blob/master/bridge/src/timeline-store.ts), and [APME documentation](https://github.com/puritysb/AgentDeck/blob/master/docs/apme.md).

### How It Could Be Useful Today

The safest initial use is a monitor-only sidecar for a host-side `forge claude` session:

- one screen showing whether the orchestrator is working, waiting, requesting approval, or idle;
- phone or Stream Deck attention signals when a human decision is required;
- a timeline of tool and lifecycle activity that complements Forge's durable artifacts;
- no authority over Forge gates, cancellation, publication, task completion, or continuation.

This would improve awareness without asking AgentDeck to understand Forge's internal state machine.

Inference: Forge's Docker task agents will not automatically become useful AgentDeck sessions. They are not AgentDeck-owned PTYs, and container-local networking does not automatically reach a host-local session bridge. Supporting them would require an explicit Forge adapter or network/protocol work, not merely installing AgentDeck on the host.

### Trial Guardrails

AgentDeck setup modifies user-level Claude and Codex hook configuration. That makes a casual installation broader than it first appears. The [hook installer](https://github.com/puritysb/AgentDeck/blob/master/hooks/src/install.ts) writes lifecycle integration into user configuration.

Verified fact: observed-session approval/control is enabled by default unless `AGENTDECK_OBSERVED_APPROVAL=0` is set. The daemon can hold a pre-tool event, influence stopping, and inject a queued directive through hooks. See the [daemon implementation](https://github.com/puritysb/AgentDeck/blob/master/bridge/src/daemon-server.ts).

A Forge-adjacent trial should therefore:

1. Back up and diff `~/.claude` and `~/.codex` configuration before and after setup.
2. Pin an AgentDeck version or commit rather than installing an unbounded latest version.
3. Set `AGENTDECK_OBSERVED_APPROVAL=0`.
4. Start with the TUI only; add remote or hardware clients later.
5. Observe one disposable host-side session, not Forge's container fleet.
6. Verify removal restores the prior hook configuration.

### Concepts Forge Should Borrow

#### Hooks-first observation

Structured lifecycle events are better than parsing terminal text. Forge should expose authoritative task and launch changes as a replayable stream, with polling only as reconciliation.

#### One hub, many projections

AgentDeck cleanly separates session collection from display devices. Forge should have one read-only projection of its durable state that can serve the dashboard, terminal UI, notifications, and optional third-party surfaces.

#### Capability-aware adapters

Agent types do not all support the same hooks, approval semantics, resume behavior, or usage data. An adapter should advertise capabilities; callers should not assume parity.

#### Separate monitor and controller authority

AgentDeck makes the risk visible: a surface that begins as a monitor can also become a controller. Forge should grant those capabilities separately and default external adapters to read-only.

#### Outcome-informed model policy

AgentDeck's APME work explores scoring and model recommendation. Forge could eventually use its own durable evidence to improve model policy: role, activity, task class, accepted result, review findings, rework, publication outcome, latency, and cost. AgentDeck's database should not become the routing authority.

### Recommended Forge Boundary

```text
Forge SQLite + launch records + gates          authoritative truth
                  |
                  v
       replayable read-only projection
          |                       |
          v                       v
  Forge dashboard       optional AgentDeck adapter
                                  |
                                  v
                    TUI / phone / Stream Deck
```

Completion, gate state, cancellation, recovery, and continuation must flow from Forge records. An AgentDeck event may attract attention; it must not advance a Forge phase.

## `asheshgoplani/agent-deck`: the tmux Manager

### What It Is

Verified fact: this Agent Deck is a Go/Bubble Tea terminal application described as mission control for AI coding agents. It manages Claude, Codex, Gemini, OpenCode, and other interactive tools through tmux. Its TUI shows sessions as running, waiting, idle/done, or error and lets an operator search, group, attach, rename, restart, fork, and send input. See its [README](https://github.com/asheshgoplani/agent-deck#readme).

Its scope is much broader than a prettier tmux selector:

- creation and persistence of tmux-backed agent sessions;
- Git worktree creation, setup, finish, merge, and cleanup flows;
- optional Docker sandboxes;
- native session forking for several agent CLIs;
- MCP and skill management;
- per-group configurations and multiple Claude accounts;
- cost collection and a web UI;
- watchers, messaging integrations, and a supervisory Conductor;
- an optional watchdog that restarts or nudges selected sessions.

This makes it much closer to Forge's operator problem than `puritysb/AgentDeck`, while also creating more overlap with Forge's responsibilities.

### Its State Model

Verified fact: each profile has a canonical SQLite database under `~/.agent-deck/profiles/<profile>/state.db`. The schema stores instances, groups, heartbeats, recent sessions, cost events, watchers, and watcher events. Session records include tmux socket/session identity, tool, project path, status, worktree metadata, and tool-specific data. See the [state database schema](https://github.com/asheshgoplani/agent-deck/blob/main/docs/internal/state-db-schema.md).

Verified fact: session identity is collected from several sources, including tmux environment, hook payloads, sidecars, and append logs. Disk scans are documented as non-authoritative. See the [session-ID lifecycle](https://github.com/asheshgoplani/agent-deck/blob/main/docs/session-id-lifecycle.md).

Verified fact: the project has explicitly worked on keeping tmux sessions alive across SSH/logout and cgroup behavior, using systemd user scopes where appropriate and preserving native agent session IDs for resume. See the [session persistence specification](https://github.com/asheshgoplani/agent-deck/blob/main/docs/SESSION-PERSISTENCE-SPEC.md).

This is substantially more durable than a shell script that lists tmux panes. It is still a session manager. A session marked done or waiting does not by itself prove that a Forge task satisfied acceptance criteria, wrote a trustworthy result, passed review, published its commit, or durably claimed a continuation.

### The Conductor

The Conductor is the most Forge-like part of agent-deck. It is a persistent Claude or Codex session in named tmux, with policy and memory files, a task log, state, heartbeats, remote messaging channels, and visibility into child sessions. It can respond automatically when policy permits and escalate otherwise. See the [Conductor documentation](https://github.com/asheshgoplani/agent-deck/blob/main/docs/conductor/README.md).

The project also documents a durable child-completion inbox and heartbeat/Stop-hook delivery. That is a useful attention-delivery pattern. It should not be confused with Forge's continuation contract: a delivered completion message is not an exactly-once compare-and-set bound to the source launch, consumer, current phase, expected prior state, and next action.

The optional [watchdog](https://github.com/asheshgoplani/agent-deck/blob/main/documentation/WATCHDOG.md) adds another supervisory layer. It can restart critical sessions and nudge a child that appears stuck from unchanged tmux output. That is useful operator automation, but its evidence remains session/process state and pane output.

### How You Might Use It

It could be genuinely useful for your non-Forge interactive work:

- keep several independent Claude and Codex conversations visible in one TUI;
- attach to the right session without remembering tmux names;
- group sessions by project;
- resume or fork a coding conversation;
- use its worktree setup for experiments that Forge does not own;
- see interactive sessions that are waiting for you.

I would not initially point it at Forge task agents or let it manage Forge worktrees and containers. A safe personal trial would use a scratch repository and one or two ordinary interactive sessions, with the Conductor, Docker, worktree automation, watchdog, and remote-control integrations disabled.

It may also be useful simply as a design reference without installing it. Its strongest value for Forge is that it demonstrates how much better session-heavy work feels when attach, grouping, status, search, and recovery are first-class product surfaces.

### Where It Conflicts With Forge

Both systems can plausibly claim ownership of:

- tmux sessions and their lifecycle;
- project and session identity;
- worktree creation and cleanup;
- Docker isolation;
- child-agent supervision;
- status classification;
- automatic restart or nudging;
- model/provider configuration;
- a coordinating orchestrator or Conductor.

If both manage the same work, failures become hard to attribute. Forge might cancel a task while agent-deck restarts its session. One system might clean a worktree the other still considers active. A pane-derived `done` could contradict a Forge task still awaiting publication recovery. Two databases would contain different answers about the same agent.

The authority boundary would need to be explicit:

```text
agent-deck owns ad hoc interactive sessions
Forge owns all Forge runs, tasks, worktrees, containers, gates, and campaigns
```

If a future integration is attempted, agent-deck should display Forge as an external read-only source or launch target. Detailed Forge state should come from a Forge API/projection, not tmux parsing. Lifecycle mutations should route back through Forge commands with normal validation and receipts.

### Concepts Forge Should Borrow

#### A real session navigator

Forge's dashboard and CLI should make it trivial to locate and attach to the human-facing orchestrator or relevant live session without exposing internal launch-name debris as the primary identity.

#### Project-first grouping

The project is the stable top-level object; branch, worktree, run, and session are subordinate context. This directly supports the dashboard correction already identified for Forge's Projects view.

#### Visible attention states

Running, waiting for input, blocked, failed, and exited should be scannable. Forge should derive its versions from durable state and authoritative launch evidence, not only pane heuristics.

#### Session forking as deliberate UX

Forking is a useful human action when exploring alternatives. Forge should keep it separate from production workflow fanout, but can borrow the clear source/child relationship and cleanup UX.

#### A durable attention inbox

The Conductor inbox is a useful model for ensuring completion signals are eventually presented to an orchestrator. Forge's stronger version is its durable completion observer and continuation claim; the UI can still borrow the inbox metaphor.

#### Watchdog honesty

The watchdog distinguishes process/session remediation from task correctness. Forge should preserve this distinction: restart or wake mechanisms restore observation and execution; they do not manufacture successful task state.

## What Forge Should Not Copy

- Do not make PTY or tmux state the authoritative task state.
- Do not create a second orchestration database for the same Forge tasks.
- Do not let a display/control sidecar decide gates, publication, cancellation, or continuation.
- Do not let another tool independently own Forge worktree or container cleanup.
- Do not infer completion from a quiet pane, exited shell, or delivered message.
- Do not install global hooks into Forge agent containers merely to gain visual status.
- Do not introduce another Conductor/orchestrator above the existing Forge orchestrator without eliminating the competing authority.

## Bounded Experiments

### Experiment 1: AgentDeck monitor-only pilot

Time-box: 60–90 minutes.

Success criteria:

- one disposable host-side Claude or Codex session appears accurately;
- state changes are visible in the TUI;
- observed approval/control is disabled;
- user-level config mutations are understood and reversible;
- no Forge task or durable state is mutated;
- removal restores prior configuration.

This experiment answers whether its displays are useful. It does not commit Forge to an adapter.

### Experiment 2: agent-deck UX trial

Time-box: one scratch-repository session.

Success criteria:

- session discovery, grouping, attach, status, and resume are materially better than raw tmux;
- the test does not touch Forge-owned worktrees, containers, sessions, or configuration;
- Conductor, watchdog, remote messaging, and automated worktree cleanup remain disabled;
- findings are recorded as Forge dashboard/operator UX ideas, not assumed integration requirements.

## Final Assessment

`puritysb/AgentDeck` is an interesting peripheral surface. Its strongest possible relationship with Forge is as a read-only projection client.

`asheshgoplani/agent-deck` is a capable tmux-centered session operating environment. It is closer to what a human running many agents wants day to day, but that closeness is exactly why direct composition is dangerous. It should either manage sessions outside Forge or contribute ideas to Forge's own operator experience; it should not silently become a second owner of Forge execution.

Forge's durable-state work remains the differentiator. The right lesson from both projects is not to replace that machinery. It is to make the machinery far easier to see and operate.

Both repositories are [MIT licensed](https://github.com/puritysb/AgentDeck/blob/master/LICENSE), including the separate [agent-deck license](https://github.com/asheshgoplani/agent-deck/blob/main/LICENSE).
