# Claude Deck / Forge Assessment

Sources reviewed:

- <https://claudedeck.org>
- <https://github.com/adrirubio/claude-deck>
- Claude Deck docs and local repository clone inspected 2026-06-24.

## Executive Summary

Claude Deck is not primarily an autonomous workflow engine. It is a local command center for existing agent CLIs, provider configuration, tmux sessions, agent mailboxes, saved agent teams, transcripts, usage, plugins, hooks, permissions, backups, and project discovery.

That makes it a useful yardstick for Forge, but in a different dimension than GasTown. GasTown is closer to an autonomous multi-agent workflow model. Claude Deck is closer to an operator surface and local agent coordination layer.

The strongest lesson for Forge is that sophisticated local agent systems need a visible control plane. Claude Deck validates several directions we have already identified:

- dashboard-first visibility for complex state;
- explicit provider and capability boundaries;
- named teams/roles as a human-friendly layer over lower-level routing;
- plan-before-launch with a stable plan hash;
- local-only trust model;
- external local APIs for orchestration;
- backups/change review before mutating real agent configuration;
- honest wakeability/delivery status instead of pretending an agent was reached.

Forge is deeper than Claude Deck on workflow execution, quality gates, isolated work, merge discipline, backlog-driven automation, and evented run/task state. Claude Deck is currently better at the human/operator surface around local agents.

The practical takeaway: Forge should not try to become Claude Deck wholesale, but it should borrow the operator-surface patterns aggressively.

## What Claude Deck Is

Claude Deck describes itself as a local command center for Claude Code and Codex CLI. Its public positioning emphasizes:

- local-only operation;
- no account;
- no telemetry;
- reads and writes real local Claude/Codex configuration;
- Agent Mail for context requests, handoffs, threads, replies, and durable per-repo identities;
- Agent Teams for saved planner/implementer/reviewer/release/devops rosters;
- Agent Bridge for discovering, spawning, resuming, forking, attaching to, and killing tmux-backed agent sessions;
- provider-aware configuration, diagnostics, usage, plugin, MCP, hook, permission, command, transcript, and backup surfaces.

Architecturally, it is a FastAPI + SQLite backend with a React/TypeScript frontend. The backend is organized as feature services: Agent Mail, Agent Teams, Agent Bridge, config, MCP, plugins, hooks, usage, backups, sessions, projects, and provider-specific services.

## Core Workflow Model

Claude Deck's workflow model is coordination-first:

- define durable participants and team slots;
- launch or reuse visible local sessions;
- attach role/charter/bootstrap context to each slot;
- route messages, context requests, handoffs, replies, and acknowledgements through Agent Mail;
- expose local APIs so other tools can plan/launch teams and send messages;
- avoid claiming wake success when a session is not actually wakeable.

The Agent Teams launch model is especially relevant:

- a team contains slots;
- each slot has provider, repository path, display name, role, charter, optional bootstrap prompt, launch mode, provider options, and enabled state;
- launch first computes a plan;
- the plan checks provider availability, Agent Mail readiness, reusable tmux sessions, disabled slots, provider option validity, and unsafe launch combinations;
- launch requires a matching `confirm_plan_hash` unless the caller explicitly skips confirmation;
- stale plan hashes return a conflict and require review of the updated plan.

That plan-hash pattern is directly applicable to Forge Campaign Runner.

## Compare / Contrast

### Source Of Truth

Claude Deck intentionally works with existing provider files as source of truth. It adds a UI and local SQLite coordination layer around those files.

Forge has a stronger internal control plane: workflow YAML, runtime YAML, task/run DB state, structured backlog, RACI, policy routing, events, gates, worktrees, and project overrides.

Claude Deck's simpler rule is easier for humans to understand: provider files remain provider files. Forge's rule is more powerful but creates more operational complexity. Forge needs dashboard surfaces that explain which layer decided what.

### Autonomy

Claude Deck does not appear to be trying to autonomously complete backlog items. It helps humans and external tools launch/reuse agents, route messages, and inspect state.

Forge is aiming at autonomous or semi-autonomous execution: accept work, route it, run agents, review, test, merge, close, and eventually run campaigns overnight.

This is Forge's advantage and risk. Claude Deck avoids many hard correctness problems by staying out of the execution loop. Forge must solve them because execution is the product.

### Agent Roles

Claude Deck's Agent Teams are human-friendly. A slot named `Planner`, `Reviewer`, `Backend owner`, or `DevOps` has a role, charter, provider, repo, launch mode, and bootstrap prompt.

Forge has workflow roles, RACI routing, seeds, and reviewers. Those are more formal and deterministic, but less approachable.

The useful lesson is the same one we discussed with human RACI: keep the machine policy explicit, but give humans a durable, friendly abstraction they can operate through.

### Same-Repo Multi-Agent Identity

Claude Deck explicitly handles same-repo planner/reviewer workflows through team slots so roles do not collapse into one repo-level participant. It warns against unsafe resume modes like multiple same-repo Codex slots using `resume --last`, because they can resume the same conversation and lose role boundaries.

Forge has the same class of issue in a different form: multiple agents in the same repo need isolated task identity, worktree identity, task manifests, reviewer context, and non-overlapping responsibilities.

This validates Forge's worktree/task identity direction and reinforces that role identity must be durable, not just prompt text.

### Communication

Claude Deck's Agent Mail is a clear product idea:

- durable participant identities;
- context requests;
- handoffs;
- replies;
- broadcasts;
- read/ack state;
- stale request detection;
- external local API;
- per-recipient wake/delivery state.

Forge has blackboard/events/task state and can already route work, but it does not yet have an equally visible human/agent mailbox concept. Reviewer Context Packet covers reviewer input, but there is still room for a general "context request / handoff / ask" surface inside Forge.

### Visibility

Claude Deck is much stronger than Forge on visibility:

- dashboard overview;
- provider-specific cards;
- live tmux session bridge;
- transcript browsing;
- config editors;
- backups;
- project discovery;
- install status;
- Agent Mail inbox state;
- Agent Teams launch planning.

Forge's dashboard is catching up with usage/governance/ops/backlog/RACI needs, but most Forge truth is still too CLI/log/backlog-heavy.

Forge visibility decision:

- Implement a Forge Home / Operator Overview that shows active runs, blocked work, waiting gates, campaigns, dirty or unsafe state, and recent failures.
- Implement run/task artifact browsing as Forge's version of transcript browsing: stdout, result JSON, task manifest, control-plane receipt, verdicts, gates, reviewer packet, changed files, commits, worktree/branch, and failure kind.
- Implement provider/runtime capability cards that explain auth, model policy, usage support, worktree support, host-test support, browser support, and Shipping Reviewer/campaign readiness.
- Implement read-only config and policy viewers before editors. Editors need validation, preview, and backup semantics first.
- Implement project discovery and install/readiness status so a human can see known projects, backlog readiness, branch/dirty state, installed adapters, auth status, and recent runs/campaigns.
- Implement a Human Attention Inbox for gate waits, reviewer blocks, context requests, campaign pauses, auth expiry, merge conflicts, and missing acceptance criteria.
- Defer config editors, workflow/team presets, general agent mail, and live session bridge until the underlying Forge objects and safety rules are clear.

### Safety

Claude Deck has useful local safety patterns:

- local-only/no telemetry trust model;
- warnings before mutating real config;
- backups before major edits;
- redacted Codex exports;
- restore refusal when provider-owned state cannot be safely restored;
- explicit provider capability gaps;
- plan hash before team launch;
- honest wakeability states.

Forge has stronger execution safety:

- containers;
- worktrees;
- no-discard merge rules;
- failure kinds;
- reds;
- gates;
- reviewer context;
- host verification;
- backlog acceptance criteria.

The systems solve different safety layers. Forge should borrow Claude Deck's operator-facing safety UX, not its execution model.

## Ideas Forge Should Steal

### 1. Plan Hashes For Campaign Approval

Claude Deck's Agent Teams launch requires a reviewed `confirm_plan_hash` unless explicitly skipped. Forge Campaign Runner should do the same:

- campaign planner emits a plan hash;
- `start` requires the approved hash;
- any reorder/scope/mode change invalidates the old hash;
- stale launch attempts fail with the updated plan.

This is a concrete way to keep delegated approval honest.

Forge trace: implemented as a planned Campaign Runner concept in FG-370, with concrete planner semantics in FG-391 and start/approval enforcement in FG-392. The Campaign Runner shipping plan also tracks `plan_hash` as a shipped-feature requirement.

### 2. Team Presets / Workflow Presets

Forge should consider a human-facing "preset" layer over workflows:

- `Shipping Review Team`;
- `Backlog Cleanup Campaign`;
- `Feature Full Pipeline`;
- `Docs/Research Pass`;
- `Release Validation`.

These should not replace workflow YAML or RACI. They should be named, operator-friendly entry points that resolve to the real workflow/policy machinery.

Forge trace: not filed as a dedicated story yet. This remains a competitive-research concept for future operator ergonomics, likely adjacent to FG-291 dashboard/operator baseline and future workflow/RACI dashboard work.

### 3. Slot Identity For Same-Repo Roles

Forge should make same-repo role identity visible:

- planner slot;
- engineer slot;
- test engineer slot;
- shipping reviewer slot;
- red reviewer slot.

Each slot should have durable role, charter, task/run context, worktree/branch identity where relevant, and a visible status. This would help the dashboard explain who did what and why.

Forge trace: partially covered by existing run/task identity, worktree identity, and reviewer-context work. FG-381 adds a Reviewer Context Packet for the Shipping Reviewer. FG-372 and its children, especially FG-384 and FG-386, are the closest active backlog path for making reviewer/role identity operational and visible.

### 4. Context Request / Handoff Surface

Forge should eventually expose first-class context requests and handoffs:

- ask another agent or role for context;
- record why it is needed;
- attach files/symbols/tickets/runs;
- track answered/acknowledged/stale state;
- show it in the dashboard.

This could unify a lot of ad hoc gate questions, reviewer asks, operator questions, and agent-to-agent handoffs.

Forge trace: not filed as a general primitive yet. FG-381 is a narrow, reviewer-specific version of context packaging. FG-380 captures the related need to move handoff/orientation operational state out of tracked project files and into host-local Forge state.

### 5. Honest Reachability States

Claude Deck distinguishes `wakeable`, `delivered_waiting`, and `offline`. Forge needs the same honesty for orchestrated work:

- task queued;
- agent spawned;
- agent reachable;
- agent mailbox/checkpoint observed;
- agent wedged;
- waiting on hook boundary;
- waiting on human.

This fits our repeated concern that a green-looking run can hide a missing or non-runnable verification path.

Forge trace: partially covered today by run/task statuses and failure kinds. FG-390 should decide whether campaign-item state can reuse Forge lifecycle status, and FG-394/FG-395 should make campaign status/reporting visible enough that "queued", "running", "waiting", "blocked", and "wedged" states are not hidden behind logs.

### 6. Operator-Safe Config Surfaces

Forge should steal the "visual but source-of-truth-aware" config model:

- RACI viewer/editor;
- model policy viewer;
- workflow/runtime viewer;
- project override viewer;
- auth profile viewer;
- seed drift viewer;
- backup/restore or export for operator-visible config.

The key rule: make the dashboard show real files/state and warn before mutation.

Forge trace: FG-291 is the parent for the stable operator baseline. FG-349 covers dashboard control-plane/config sources. FG-386 should surface readiness and done-audit state. Existing backlog/dashboard/RACI viewer stories should be treated as part of this same operator-safe surface family.

### 7. Backup Before Mutating Agent Configuration

Claude Deck emphasizes backups before modifying real local config. Forge setup/init/upgrade should do the same for operator-facing config:

- `.claude`;
- `.codex`;
- MCP config;
- project Forge config;
- RACI/project overrides.

This is especially relevant if Forge setup grows optional addons like Stream Deck or local dashboard integrations.

Forge trace: not filed as a dedicated story from this document. Related existing direction lives in FG-253 provider-adapter surfaces, FG-291 setup/operator baseline, and FG-387 optional Stream Deck/operator-surface addon work.

### 8. Provider Capability Matrix

Claude Deck hides or disables surfaces when provider parity does not exist. Forge should make capability gaps explicit:

- can this provider stream usage?
- can this agent run host tests?
- can this runtime access dependency volumes?
- can this project use worktrees?
- can this project create PRs?
- can this workflow use Shipping Reviewer?

This should be dashboard-visible and included in campaign reports.

Forge trace: FG-401 covers the dashboard provider/runtime capability matrix. FG-395 should include campaign-specific capability visibility in campaign reports.

### 9. External Local API For Orchestration

Claude Deck's local external API is a good pattern. Forge's orchestrator/campaign runner could expose stable machine-readable control endpoints or CLI JSON contracts for:

- plan campaign;
- approve campaign;
- show status;
- pause/resume;
- request context;
- retrieve report.

This should not replace CLI, but it would make dashboard, Stream Deck, and other local operator tools cleaner.

Forge trace: partially represented by FG-394, which requires human and JSON campaign report/status output. FG-387 depends on stable dashboard URLs and read-mostly status endpoints for Stream Deck. A broader local API contract is not yet filed.

### 10. Launch Result Vocabulary

Claude Deck's team launch result states are practical: reused, spawned, pending registration, failed, skipped disabled, blocked provider unavailable, blocked mail not configured.

Forge Campaign Runner should be similarly explicit:

- reused existing run/session;
- spawned run;
- pending registration;
- blocked readiness;
- blocked gate unavailable;
- held dependency;
- failed infrastructure;
- shipped;
- skipped by operator.

Forge trace: FG-390 owns the first campaign state model and should keep lifecycle status aligned with Forge run/task status while storing campaign-specific meaning as adjacent outcome/blocker fields. FG-393 owns blocker and continue semantics.

## What Forge Already Does Better

Forge is ahead on the hard workflow-engine problems:

- backlog-driven work rather than session launch only;
- structured workflow execution;
- durable run/task state;
- RACI and routing policy;
- container isolation;
- worktree isolation and merge-back;
- no-discard invariants;
- red review and Shipping Reviewer direction;
- host verification requirements;
- failure-kind modeling;
- campaign planning direction;
- task manifests and reviewer context packets.

Claude Deck is not trying to prove that a feature shipped correctly. Forge is.

## What Not To Copy

### Do Not Make The UI The Workflow Engine

Claude Deck can be UI-forward because it coordinates humans and sessions. Forge should keep the workflow engine durable and headless. The dashboard should observe/control, not become the only place correctness lives.

### Do Not Rely On Tmux Wakeups For Correctness

Wakeups are useful operator ergonomics, but Forge should not depend on "send text to pane" as a core correctness mechanism. Forge's container/task/event model is stronger.

### Do Not Let The Surface Area Grow Without A Capability Model

Claude Deck has a very wide feature surface. Forge already has operational complexity risk. Any borrowed surface should tie back to a real Forge control-plane object: run, task, campaign, backlog item, gate, workflow, policy, provider, project, or config file.

### Do Not Accept Machine-Global Visibility Without Thought

Claude Deck's Agent Mail docs note machine-global visibility. Forge projects may need clearer project/workspace boundaries, especially once multiple projects and campaign runs are active.

## Validation Of Forge Direction

Claude Deck validates several Forge bets:

- **Dashboard backlog/RACI/workflow visibility matters.** Complex local agent systems need a human-readable command center.
- **Human-friendly roles are useful.** Team slots map well to our RACI-as-human-layer idea.
- **Plan approval needs stable identity.** Plan hashes are a concrete mechanism for campaign approval.
- **Local-only is a reasonable trust model.** Forge does not need cloud control to be powerful.
- **Provider boundaries should be explicit.** Forge should show what each model/runtime/provider can actually do.
- **External local orchestration is useful.** Campaign Runner, dashboard, Stream Deck, and operator scripts should consume stable machine-readable contracts.
- **Agent-to-agent context requests are real.** Reviewer Context Packet is one special case; a broader context-request primitive may be valuable.

## Traceability Appendix

This section keeps the research-to-backlog link explicit. The research doc is not the source of truth for implementation, but it should explain where borrowed concepts landed or where they are still only ideas.

### Concept Glossary

- `plan_hash`: a stable hash of the canonical resolved campaign plan. It is the approval boundary for delegated campaign execution. Tracked in FG-370, FG-391, and FG-392.
- Team preset: a human-friendly named entry point over workflows, RACI, seeds, and model/runtime policy. Not filed yet.
- Slot identity: durable identity for same-repo roles such as planner, engineer, test engineer, shipping reviewer, and red reviewer. Partially related to FG-372, FG-381, FG-384, and FG-386.
- Context request / handoff: a first-class request for another agent, role, or human to provide context or make a decision. Narrowly represented by FG-381 and related to FG-380, but not filed as a general primitive.
- Reachability state: an honest state for whether a task/agent is queued, spawned, reachable, wedged, waiting on a gate, or waiting on a human. Related to FG-390, FG-394, and FG-395.
- Operator-safe config surface: a dashboard or CLI surface that shows real source-of-truth files/state, explains precedence, and warns before mutation. Related to FG-291, FG-349, and FG-386.
- Provider capability matrix: a visible statement of what a provider/runtime/project can actually do. Tracked by FG-401.
- Local operator API: stable JSON/endpoint contracts for dashboard, Stream Deck, campaigns, and other local controls. Partially related to FG-394 and FG-387.
- Launch/result vocabulary: explicit outcomes for launched/reused/blocked/skipped/failed/shipped work. Related to FG-390 and FG-393.

### Filed Backlog Links

- FG-370: Campaign Runner epic, including `plan_hash`, approval, campaign state, and campaign report requirements.
- FG-390: Campaign data model and campaign-item lifecycle/outcome fields.
- FG-391: Campaign planner, epic expansion, canonical plan content, and stable `plan_hash`.
- FG-392: Sequential campaign execution, approved plan enforcement, and stale `plan_hash` rejection.
- FG-393: Campaign blocker and continue semantics.
- FG-394: Campaign CLI status, control, and campaign report JSON.
- FG-395: Dashboard campaign view.
- FG-400: Dashboard Forge Home / Operator Overview.
- FG-401: Dashboard Provider/Runtime Capability Matrix.
- FG-402: Dashboard Human Attention Inbox.
- FG-372 / FG-381 / FG-384 / FG-386: Shipping Reviewer, reviewer context, acceptance review, and dashboard/operator surface.
- FG-349: Dashboard control-plane/config source visibility.
- FG-380: Host-local operational state for handoff/orient/session notes.
- FG-387: Stream Deck operator control surface addon.

### Unfiled Concepts To Revisit

- Workflow/team presets as named operator-friendly launch profiles.
- General context-request/handoff primitive beyond the Shipping Reviewer packet.
- Backup/change-preview behavior before Forge setup/init/upgrade mutates provider or operator configuration.
- Broader local operator API beyond CLI JSON contracts.

## Bottom Line

Claude Deck is a strong validation that the next layer of Forge value is not only more autonomy. It is visibility, control, and operator trust.

Forge should remain the workflow engine. Claude Deck is a useful reference for the local command center around that engine.
