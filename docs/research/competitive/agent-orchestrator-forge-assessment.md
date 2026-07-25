# Agent Orchestrator Assessment Compared to Forge

Date: 2026-07-24

Project:
[`AgentWrapper/agent-orchestrator`](https://github.com/AgentWrapper/agent-orchestrator)

Snapshot inspected:
[`30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e`](https://github.com/AgentWrapper/agent-orchestrator/tree/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e).

## Executive Take

Agent Orchestrator, or AO, passes the current eligibility filter:

- Apache-2.0 open-source license;
- no required AO product, hosted-service, or license fee was found;
- current implementation is Go plus Electron and TypeScript, with no tracked
  Python;
- installed Claude Code and Codex CLIs preserve their existing subscription
  authentication.

AO is the strongest inspectable lifecycle and operator-product comparison in
this filtered set. It gives every worker a branch and worktree, persists
sessions in SQLite, fences stale launch observations with generation IDs,
preserves dirty work, adopts surviving runtimes after daemon restart, and
feeds CI and review failures back to workers.

It is not yet a safe drop-in Forge replacement. It lacks Forge's durable
backlog and deterministic workflow model, cannot complete final publication
through its own backend, uses the host-wide default tmux server, mishandles
locked worktree force cleanup, and defaults Codex workers to broad host access.

Recommended disposition:

1. Keep AO as the second-ranked deep-dive candidate.
2. Run only a disposable-repository and isolated-host-resource pilot.
3. Borrow its launch-generation fencing, preservation refs, lifecycle UI, and
   daemon reconciliation ideas.
4. Do not place Forge-owned work or credentials under it until the tmux,
   worktree cleanup, local API, and sandbox issues are resolved.
5. Do not replace Forge's task, gate, or publication authority with AO.

## Eligibility

| Requirement | Result | Evidence |
|---|---|---|
| Open source | Pass | Apache-2.0 license. |
| No required product fee | Pass | Public source and GitHub release binaries; no mandatory paid AO tier or control plane was found. |
| No Python | Pass | Current architecture is a Go daemon and CLI plus an Electron/TypeScript desktop application. |

External agent subscriptions, API use, GitHub service, and compute remain
operating costs. The finding is only that AO adds no required product fee.

## Architecture and Authority

The current generation uses a local Go daemon and CLI, an SQLite database,
workspace and runtime adapters, and an Electron/React supervisor:

```text
desktop / CLI / LLM orchestrator
               |
               v
       loopback Go daemon
               |
       +-------+--------+
       |                |
    SQLite          lifecycle manager
                        |
               +--------+--------+
               |                 |
          Git worktree       tmux runtime
               |                 |
             branch        Claude/Codex/etc.
```

SQLite is the durable authority for AO sessions. It uses WAL and a serialized
writer. Runtime status is derived from persistent session state plus current
observations rather than being trusted solely from the UI.

The “orchestrator” itself is still an LLM session instructed to inspect,
spawn, message, and monitor workers. AO does not expose a Forge-equivalent
durable backlog, dependency DAG, campaign ledger, deterministic scheduler, or
transactional workflow gate model. Its durable domain is supervised sessions,
not the full delivery contract.

## Worktrees and Lifecycle Safety

Every worker receives a separate branch and Git worktree. Spawn includes
durable session creation, workspace creation, provisioning, hook installation,
runtime launch, handle persistence, and rollback paths. AO also validates that
managed paths remain inside the expected workspace root.

Two mechanisms are particularly strong:

- launch-generation IDs reject observations from a superseded worker launch;
- dirty tracked and non-ignored untracked changes can be preserved in
  `refs/ao/preserved/<session-id>` through a temporary Git index.

Ordinary cleanup preserves a dirty worktree rather than silently destroying
it. Those are good foundations for honest recovery.

The force-cleanup path has a serious defect. It issues one `git worktree
remove --force`, ignores failure, prunes, and then recursively removes the
directory. A locked worktree requires an unlock or double force. AO can
therefore erase the directory while leaving a locked Git registration, and a
later restore path may accept that stale registration without verifying the
path still exists.

This is the same failure class Forge is addressing in FG-356.

## Process Recovery and tmux

AO's reaper detects dead supervised workloads and marks the session exited
while preserving the worktree. Resume is explicit rather than automatic.

After a daemon restart, AO can adopt surviving tmux sessions and reconcile
missing runtimes. Worktree state and preservation refs provide a credible
relaunch basis after a machine restart, although no end-to-end host-reboot
chaos proof was found.

AO uses ordinary tmux commands against the host's default server; it does not
select an application-private socket with `tmux -L`. Verifying a pane's current
directory after creation does not remove the shared-daemon risk.

This exposes AO to the exact class of failure that disabled Forge launches in
July 2026: a host-wide tmux server can retain a deleted working directory,
poison later child launches, and create cross-application cleanup blast radius.
A pilot must isolate AO's tmux server before its recovery claims are trusted.

## Review and Publication

AO persists CI failures, requested changes, unresolved comments, and merge
conflicts, deduplicates them, and nudges the worker. This is useful closed-loop
supervision.

Review is explicit, but the inspected production paths did not prove an
automatic mandatory gate. Reviews are triggered through an endpoint, and
reviewers post comments and internal verdicts rather than GitHub approvals or
change-request reviews because they use the operator's GitHub identity.

Final publication is a harder stop. The PR action service says its business
logic is unimplemented. Merge parses a PR number and returns apparent success,
comment resolution returns zero, and production daemon construction does not
inject the service. The endpoint therefore returns 501. A worker or human must
perform final merge through GitHub or `gh`.

AO cannot currently carry the fixed scenario through authoritative
publication.

## Authentication and Runtime Boundary

| Path | Assessment |
|---|---|
| Claude Pro/Max subscription | Supported through the installed and authenticated Claude Code CLI. |
| Codex through ChatGPT subscription | Supported through the installed and authenticated Codex CLI. |
| Claude through Amazon Bedrock | Unknown. Project environment is forwarded, so Claude Code pass-through may work, but AO has no Bedrock documentation or tests. |

By default, Codex execution can include
`--dangerously-bypass-approvals-and-sandbox` unless the project is configured
more restrictively. Workers use host worktrees rather than containers and
retain host network and credential reach.

The worktree is therefore an isolation boundary for Git changes, not a
security boundary.

## Local API and Telemetry

The local loopback daemon is unauthenticated. Any local process able to reach
it can invoke mutating endpoints. That is material on a developer workstation
running browsers, extensions, package scripts, and other agent processes.

Distributed desktop builds also enable anonymous PostHog analytics and
renderer session recording with redactions. Daemon telemetry can be disabled
with environment variables; fully removing renderer transmission requires a
self-build with an empty PostHog key.

These do not violate the open/free filter, but they materially affect the
trust decision.

## Fixed Failure Scenario

| Event | AO behavior | Assessment |
|---|---|---|
| Two parallel changes | Separate branches, worktrees, and durable session IDs. | Strong isolation. |
| One worker crashes | Reaper records `exited`; worktree and preserved state survive; explicit resume required. | Honest detection, partial recovery. |
| Review rejects a change | Persisted review and CI state can nudge the worker. | Useful loop, but not proven as a deterministic mandatory gate. |
| Daemon restarts | Surviving tmux sessions are adopted; missing runtimes can be reconciled. | Good, subject to shared tmux and stale-worktree defects. |
| Host restarts | Worktree and SQLite state survive and appear sufficient for relaunch. | Plausible, but not chaos-tested end to end. |
| Final publication | AO backend does not implement merge. | Fail; worker or human must publish. |

## What Forge Should Retain

### Fence observations by launch generation

A status event from a process that has already been replaced must not mutate
the current attempt. AO's launch-generation check is a compact, valuable
pattern for process and provider observations.

### Preserve dirty work outside the checkout

The `refs/ao/preserved/<session-id>` approach gives recovery a durable Git
object even when ordinary worktree cleanup cannot proceed. Forge should compare
this with its own evidence and orphan-recovery contracts.

### Make reconciliation a daemon responsibility

AO does not leave every recovery decision to the desktop UI. The daemon owns
adoption, missing-runtime reconciliation, reaping, and derived status. That
separation is appropriate.

### Feed external review state back to the worker

Persisting and deduplicating CI failures, requested changes, unresolved
comments, and conflicts is a useful feedback primitive. Forge should retain
stronger gate authority while borrowing the operator and worker feedback loop.

## What Forge Should Not Copy

- Host-wide default tmux rather than a private application socket.
- Single-force locked-worktree cleanup followed by recursive directory removal.
- Restore that trusts a Git registration without verifying its path.
- Default Codex execution with sandbox and approvals bypassed.
- An unauthenticated mutating local API.
- Review language stronger than the actually wired enforcement path.
- Apparent PR-action success when merge business logic is unimplemented.

## Verdict

**Eligible, technically serious, and worthy of a contained pilot; not a safe
Forge replacement today.**

AO has the strongest lifecycle substrate of the non-Stoneforge candidates and
several ideas Forge should study closely. Its shared tmux dependency,
locked-worktree defect, broad worker permissions, incomplete publication, and
missing deterministic workflow model are disqualifying for migration now.

## Primary Evidence

- [License](https://github.com/AgentWrapper/agent-orchestrator/blob/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e/LICENSE)
- [Current stack](https://github.com/AgentWrapper/agent-orchestrator/blob/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e/docs/stack.md)
- [Session spawn and recovery manager](https://github.com/AgentWrapper/agent-orchestrator/blob/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e/backend/internal/session_manager/manager.go)
- [SQLite authority](https://github.com/AgentWrapper/agent-orchestrator/blob/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e/backend/internal/storage/sqlite/db.go)
- [Launch-generation fencing](https://github.com/AgentWrapper/agent-orchestrator/blob/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e/backend/internal/lifecycle/manager.go)
- [Worktree cleanup, restore, and preservation refs](https://github.com/AgentWrapper/agent-orchestrator/blob/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e/backend/internal/adapters/workspace/gitworktree/workspace.go)
- [Default-server tmux commands](https://github.com/AgentWrapper/agent-orchestrator/blob/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e/backend/internal/adapters/runtime/tmux/commands.go)
- [Reaper](https://github.com/AgentWrapper/agent-orchestrator/blob/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e/backend/internal/observe/reaper/reaper.go)
- [Review and CI reactions](https://github.com/AgentWrapper/agent-orchestrator/blob/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e/backend/internal/lifecycle/reactions.go)
- [Unimplemented PR action service](https://github.com/AgentWrapper/agent-orchestrator/blob/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e/backend/internal/service/pr/action_service.go)
- [Codex execution mode](https://github.com/AgentWrapper/agent-orchestrator/blob/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e/backend/internal/adapters/agent/codex/codex.go)
- [Telemetry behavior](https://github.com/AgentWrapper/agent-orchestrator/blob/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e/docs/telemetry.md)
