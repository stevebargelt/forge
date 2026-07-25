# Stoneforge Assessment Compared to Forge

Date: 2026-07-24

Project:
[`stoneforge-ai/stoneforge`](https://github.com/stoneforge-ai/stoneforge)

Snapshot inspected:
[`0a7052a9ffa1fb42fafbff9d9b6b83fa48cdad95`](https://github.com/stoneforge-ai/stoneforge/tree/0a7052a9ffa1fb42fafbff9d9b6b83fa48cdad95),
version 1.25.0.

## Executive Take

Stoneforge passes the current eligibility filter:

- Apache-2.0 open-source license;
- local and self-hosted orchestration requires no Stoneforge product fee;
- TypeScript and JavaScript implementation, not Python;
- provider adapters for Claude, Codex, and OpenCode;
- durable task, agent, worktree, review, and merge concepts that overlap
  directly with Forge.

It is the strongest candidate in the filtered landscape and the only one that
approaches Forge's complete product shape. It is not ready to replace Forge
today.

The blockers are correctness at the exact failure boundaries that matter:
task assignment has no atomic claim or fencing token; the merge “optimistic
lock” is a read/check/write rather than compare-and-swap; rejected human review
can stall; concurrent merges race; crash recovery can leak temporary merge
worktrees; and agents run with broad host permissions and inherited secrets.

Recommended disposition:

1. Keep Stoneforge ranked first.
2. Run a contained, disposable-repository pilot against explicit chaos cases.
3. Do not migrate production orchestration until assignment, rejection,
   publication, cleanup, and permission boundaries pass.
4. Expect that adopting it now could mean owning a correctness fork rather than
   merely installing a finished product.

## Eligibility and Cost

| Requirement | Result | Evidence |
|---|---|---|
| Open source | Pass | Apache-2.0 license. |
| No required product fee | Pass | Solo and self-hosted orchestration is local and free; a future team service is separate. |
| No Python | Pass | TypeScript/JavaScript monorepo using Bun or Node, React, and SQLite. |

Stoneforge itself adds no required charge, but it warns that unconstrained
multi-agent use can consume several model subscriptions per week. “No product
fee” should not be mistaken for predictable or negligible model cost.

## Architecture and Authority

`sf serve` is a long-running local process containing a Hono HTTP and dashboard
server, dispatch daemon, SQLite runtime store, debounced JSONL export, provider
adapters, worktree services, and merge stewards:

```text
dashboard / CLI
       |
       v
long-running Stoneforge server
       |
       +--> dispatch daemon --> provider agent
       |                         |
       |                     task worktree
       |
       +--> SQLite runtime state
       |          |
       |          +--> audit events
       |          +--> debounced JSONL export
       |
       +--> review and merge stewards
```

The dashboard is a projection over the server API and React Query cache. It is
not the authority.

SQLite is the immediate runtime authority. Documentation calls JSONL the source
of truth, but export is debounced, by default for up to five minutes.
Mutations update materialized SQLite rows and append audit events. This is a
hybrid materialized-state-plus-audit design rather than strict event sourcing.
If SQLite is lost before export, recent state may be lost despite the stronger
documentation language.

## Worktrees and Crash Recovery

Stoneforge gives dispatched workers isolated worktrees and records assignment,
branch, worktree, provider, and session information.

Daemon startup performs meaningful reconciliation:

- agents whose recorded process no longer exists are detected;
- assigned ephemeral workers without a live session are found;
- the recorded branch and worktree are reused;
- provider-session resume is attempted;
- recovery falls back to a fresh agent in the same filesystem state;
- repeated failure is capped and escalated to a recovery steward.

This is substantially better than process-only orchestration. Uncommitted
filesystem state can survive an agent or daemon crash because the worker
returns to the same worktree.

The cleanup contract is weaker. Startup prunes stale Git registrations, but no
general orphan reaper or unlock-first path was found. Merge cleanup
force-removes a worktree and silently ignores failure. The recovery search
pattern does not match the timestamped merge directories actually created, so
a host crash can leave a registered worktree that ordinary prune will retain.

## Assignment and Concurrency Correctness

Task assignment reads a task, updates its assignee, then separately updates
orchestration metadata. The implementation delegates reassignment safety to
callers. There is no atomic claim, lease, generation, or fencing token.

Two dispatchers can therefore both believe they acquired the same task. Even
if the normal deployment intends one daemon, correctness should be enforced at
the state transition rather than by an unstated process-count assumption.

The merge steward has a similar issue. Its “optimistic lock” reads current
status, compares it in memory, and then performs an ordinary update. The
database write is not conditional on the previously observed value.

Concurrent merges can also start from the same remote target. The first push
wins; the second can fail non-fast-forward and become failed rather than
fetching, rebasing, and retrying under a serialized publication lane.

## Review and Rework

Automated test or merge failure can produce fix work while retaining useful
branch context. That is a promising closed-loop design.

Human rejection is incomplete:

- closing a required-approval pull request without merging sets merge status
  to failed while the task remains in review;
- no automatic rework task or reopening transition follows;
- manual `sf task reject` reopens the task, but does not preserve the current
  branch and worktree as explicit handoff state;
- redispatch can create a new branch and worktree, abandoning the rejected
  changes.

An unmerged project pull request also reports that CLI completion can bypass
`merge.requireApproval` and use local merging. This should be treated as an
open risk until the behavior is tested at the selected snapshot or fixed.

## Publication

Stoneforge's merge path has a good safety shape: it does not modify the main
checkout. It creates a detached temporary worktree, fetches the target, runs
tests and squash merge there, pushes the remote, and then synchronizes the
local target best-effort.

This reduces self-host and operator-checkout blast radius. It does not solve
the assignment, CAS, concurrent-push, or crash-orphan issues above.

Publication is therefore more complete than the other filtered candidates,
but not yet transactionally safe under concurrency and interruption.

## Authentication and Security Boundary

| Path | Assessment |
|---|---|
| Claude Pro/Max subscription | Supported through Claude Agent SDK or Claude CLI subscription authentication. An `ANTHROPIC_API_KEY`, if present, can override this and incur API charges. |
| Codex through ChatGPT subscription | Likely supported because Stoneforge launches installed `codex app-server` and inherits its login. Stoneforge documentation still incorrectly says an API key is required. |
| Claude through Amazon Bedrock | Architecturally likely through Claude Code environment configuration, but Stoneforge does not document or test it. Bedrock is separately metered. |

Worktrees isolate Git changes; they are not an OS security boundary.

- Claude runs with permissions skipped or bypassed.
- Codex uses `approvalPolicy: never` and `danger-full-access`.
- approval requests are auto-accepted;
- child agents inherit the server's complete environment, including secrets;
- the API defaults to localhost but has no evident native authentication if
  exposed on another interface.

A production pilot must narrow credentials and permissions before testing
untrusted or adversarial work.

## Fixed Failure Scenario

| Event | Stoneforge behavior | Assessment |
|---|---|---|
| Two parallel changes | Each receives an isolated worktree. | Strong filesystem separation; assignment is not atomically fenced. |
| One agent crashes | Assignment and filesystem remain; startup can resume the provider session or respawn in the same worktree. | Strong ordinary recovery. |
| Automated review rejects | Failure can create fix work and retain useful context. | Promising. |
| Human closes the PR | Merge becomes failed while task remains in review. | Stalls without operator rejection/reopen. |
| Host restarts | SQLite restores current assignments; dashboard reconstructs from server state. | Good, but JSONL can lag and merge worktrees can leak. |
| Two merges publish concurrently | Both may start from one remote tip; one push can fail non-fast-forward. | No serialization or automatic retry. |
| Final publication | Detached merge worktree tests, merges, and pushes. | Most complete candidate, but not concurrency-safe. |

The complete scenario does not yet finish autonomously and correctly.

## Maturity

At the inspected snapshot the repository was young and concentrated:

- created in February 2026;
- 829 commits, with roughly 94% attributed to one human contributor;
- 164 stars, 27 forks, and 37 open issues at inspection time;
- main had not advanced since May 5;
- dynamic agent-pool behavior was documented ahead of implementation;
- the committed full orchestration lifecycle end-to-end test was skipped.

Package tests were extensive and mostly green:

| Package | Local result |
|---|---|
| core | 2,737 passed, 22 skipped |
| storage | 137 passed |
| smithy | 1,568 passed, 19 skipped |
| quarry | 4,259 passed, 1 skipped, 1 repeatable timeout failure |

The repeatable failure was in a Notion provider-registry test. Installation
also warned that `better-sqlite3` could not find `node-gyp` under Node 26,
although Bun-based tests largely succeeded.

## Pilot Exit Criteria

A contained pilot should fail unless it proves:

1. one-daemon ownership plus atomic task claims or equivalent fencing;
2. recovery of uncommitted edits after agent and daemon kill;
3. human rejection returning to the same branch and worktree;
4. serialization or automatic retry of simultaneous merges;
5. recovery of locked and crash-orphaned worktrees;
6. Claude subscription and ChatGPT Codex subscription login in the actual
   server process;
7. Bedrock credential propagation, if still relevant;
8. secret isolation and reduced agent permissions;
9. recent-state survival across SQLite loss before JSONL export.

## What Forge Should Retain

### Resume in the same worktree before starting over

Provider session identity may be lost while valuable filesystem state remains.
Stoneforge's recovery order—reuse assignment, branch, and worktree; attempt
session resume; then respawn—is the right general shape.

### Merge away from the running checkout

Detached temporary merge worktrees keep publication changes out of the main
operator or self-host checkout. Forge should preserve and strengthen this
boundary with serialization, fencing, and reliable cleanup.

### Make the dashboard a projection

The operator UI reads authoritative server state rather than independently
deciding task transitions. This aligns with Forge's intended boundary.

## What Forge Should Not Copy

- Assignment safety delegated to single-daemon convention rather than an
  atomic claim.
- In-memory status comparison presented as an optimistic lock.
- Human rejection that can strand a task in review or abandon its branch.
- Concurrent merge attempts without a serialized publication lane.
- Silent failure during temporary-worktree cleanup.
- Documentation that overstates JSONL authority relative to debounced export.
- Full-access, no-approval agents inheriting the server's whole environment.

## Verdict

**The strongest candidate and the first pilot target, but not migration-ready.**

Stoneforge demonstrates that an Apache-licensed TypeScript system can combine
durable orchestration, worktrees, recovery, reviews, and publication in a
coherent product. Its gaps are patchable, but they sit in the correctness
model. Adopting it today would likely mean taking responsibility for those
invariants in a fork.

## Primary Evidence

- [License and project source](https://github.com/stoneforge-ai/stoneforge/tree/0a7052a9ffa1fb42fafbff9d9b6b83fa48cdad95)
- [Core model](https://docs.stoneforge.ai/core-concepts/overview/)
- [Orchestration lifecycle](https://docs.stoneforge.ai/core-concepts/orchestration-loop/)
- [Sync and merge model](https://docs.stoneforge.ai/core-concepts/sync-and-merge/)
- [Storage schema](https://github.com/stoneforge-ai/stoneforge/blob/0a7052a9ffa1fb42fafbff9d9b6b83fa48cdad95/packages/storage/src/schema.ts)
- [Task assignment implementation](https://github.com/stoneforge-ai/stoneforge/blob/0a7052a9ffa1fb42fafbff9d9b6b83fa48cdad95/packages/smithy/src/services/task-assignment-service.ts)
- [Startup reconciliation](https://github.com/stoneforge-ai/stoneforge/blob/0a7052a9ffa1fb42fafbff9d9b6b83fa48cdad95/packages/smithy/src/orchestrator/dispatch-daemon.ts)
- [Provider-session reconciliation](https://github.com/stoneforge-ai/stoneforge/blob/0a7052a9ffa1fb42fafbff9d9b6b83fa48cdad95/packages/smithy/src/services/session-manager.ts)
- [Merge steward and rejection behavior](https://github.com/stoneforge-ai/stoneforge/blob/0a7052a9ffa1fb42fafbff9d9b6b83fa48cdad95/packages/smithy/src/services/merge-steward-service.ts)
- [Detached merge worktree and cleanup](https://github.com/stoneforge-ai/stoneforge/blob/0a7052a9ffa1fb42fafbff9d9b6b83fa48cdad95/packages/smithy/src/git/merge.ts)
- [Codex headless permissions](https://github.com/stoneforge-ai/stoneforge/blob/0a7052a9ffa1fb42fafbff9d9b6b83fa48cdad95/packages/smithy/src/providers/codex/headless.ts)
- [Claude interactive permissions](https://github.com/stoneforge-ai/stoneforge/blob/0a7052a9ffa1fb42fafbff9d9b6b83fa48cdad95/packages/smithy/src/providers/claude/interactive.ts)
- [Reported approval bypass, PR #107](https://github.com/stoneforge-ai/stoneforge/pull/107)
