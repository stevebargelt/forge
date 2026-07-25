# Maestro Assessment Compared to Forge

Date: 2026-07-24

Project: [`josstei/maestro-orchestrate`](https://github.com/josstei/maestro-orchestrate)

Snapshot inspected:
[`4f5d434dded8a5e58808ad60f56c6e410f57cf7e`](https://github.com/josstei/maestro-orchestrate/tree/4f5d434dded8a5e58808ad60f56c6e410f57cf7e),
version 1.6.4.

## Executive Take

Maestro passes the current eligibility filter:

- Apache-2.0 open-source license;
- no Maestro product or service fee required;
- JavaScript and Node.js implementation, not Python;
- Claude Code and Codex are both supported host runtimes.

It is not a safe Forge replacement. Maestro is best understood as a portable,
well-developed playbook and methodology layer running inside another agent
host. It gives that host specialist roles, design and planning phases, review
methods, and Markdown session records. It does not provide independent process
supervision, worktree isolation, transactional task ownership, fenced
publication, or a merge authority.

Recommended disposition:

1. Keep Maestro in the deep-dive set as a playbook-layer reference.
2. Borrow its generated, cross-runtime workflow source and its explicit
   Express-versus-Standard split.
3. Do not use its shared-workspace parallel mode for overlapping changes.
4. Do not treat its Markdown gates as enforcement equivalent to Forge gates.
5. Do not replace Forge's task, worktree, review, or publication authority with
   Maestro state.

## Eligibility

| Requirement | Result | Evidence |
|---|---|---|
| Open source | Pass | Apache-2.0 license in the repository and package metadata. |
| No required product fee | Pass | Installation is from the public repository, plugin marketplace, or public npm package; no Maestro-paid tier is required. |
| No Python | Pass | The implementation is JavaScript and Node.js plus generated Markdown, JSON, and TOML runtime artifacts. |

“Free” here excludes the Claude, ChatGPT, or other model subscription the
operator elects to use. Maestro itself does not add a required license or
managed-service charge.

## Product and Architecture

Maestro maintains one canonical `src/` tree and generates runtime-specific
artifacts for Gemini CLI, Claude Code, Codex, and Qwen Code. It exposes 39
specialists, an Express path for simple work, and a four-phase Standard path
for larger work. The project describes the ordinary Standard flow as design,
plan, execute, and complete, with approval and final-review gates.

This portability is its strongest architectural idea:

```text
canonical JavaScript and methodology source
                    |
                    v
       generated runtime-specific artifacts
                    |
       +------------+-----------+
       |            |           |
    Claude        Codex       Gemini/Qwen
       |            |           |
       +------ host agent runtime -------+
                    |
                    v
         project files + docs/maestro
```

The host runtime still owns agents, shell commands, filesystem access,
permissions, and process lifetime. Maestro does not place a supervisory daemon
or isolation boundary beneath those hosts.

## State and Concurrency

Session, plan, phase-report, validation, and archive records normally live
under `docs/maestro`. This makes them inspectable, versionable, and likely to
survive an application restart.

The state contract is not transactional. The core update helper reads an
active session, mutates it, then writes it back. Writes use a temporary file
and rename, which prevents partial files, but there is no lock, compare-and-set
version, lease, or fencing token. Two writers can therefore each read the same
state and let the later write erase the earlier transition.

Parallel execution is governed by methodology:

- parallel phases should be siblings in the plan DAG;
- agents should touch non-overlapping declared files;
- conflicting or dependent work should run sequentially;
- a concurrency cap can be configured.

All agents still share the same project checkout. The non-overlap rule reduces
risk only when the plan is correct and every agent follows it. It does not
contain a mistaken edit. That is the decisive mismatch with Forge's worktree
model.

## Gates and Enforcement

Maestro's Standard workflow requires an approved plan, validation evidence, and
resolution of Critical or Major review findings. Those are good workflow
expectations.

On Codex, however, Maestro explicitly documents that:

- there are no runtime hooks;
- there is no runtime policy enforcement;
- constraints are carried in skills and agent methodology;
- if the MCP state server is unavailable, agents may fall back to direct file
  operations.

The distinction matters. A well-prompted agent can usually follow a gate; a
durable workflow engine can refuse an invalid state transition. Maestro offers
the former on Codex, not the latter.

## Recovery

Maestro's records survive because they are project files. Its recovery
methodology scans filesystem changes, asks the operator to attribute ambiguous
work, and reconciles or retries unfinished phases. This is useful, honest
recovery guidance.

It does not restore a dead in-flight agent process. It cannot prove that a
particular filesystem change came from a particular agent. It relies in part
on file timestamps and operator confirmation. After a host restart, the
expected path is therefore to read durable session files, reconcile the
checkout, and rerun unfinished work.

That is better than losing all context, but it is not attempt-level process
recovery or proof.

## Authentication

| Path | Assessment |
|---|---|
| Claude Pro/Max subscription | Supported through the already authenticated Claude Code host. |
| Codex through ChatGPT subscription | Supported through the already authenticated Codex host. |
| Claude through Amazon Bedrock | Inferred through an appropriately configured Claude Code host, but not explicitly documented or tested by Maestro. |

Maestro does not convert API-key billing into subscription access. It inherits
the authentication, permissions, and environment of the selected runtime.

## Fixed Failure Scenario

The common evaluation scenario is two parallel changes, one agent crash, one
rejected review, a host restart, and final publication.

| Event | Maestro behavior | Operator burden or gap |
|---|---|---|
| Two parallel changes | Methodology permits parallel sibling phases with non-overlapping planned files. | Both agents share one checkout. A mistaken overlap is not contained. |
| One agent crashes | Session files and filesystem scan support reconciliation and retry. | The process is not restored; attribution may require operator judgment. |
| Review rejects a change | Standard workflow says unresolved Critical or Major findings block completion and may be retried. | On Codex this is prompt-level policy, not a runtime-enforced transition. |
| Host restarts | `docs/maestro` state survives and unfinished work can be resumed. | In-flight agents are gone; checkout state must be reconciled. |
| Final publication | No native merge queue, PR authority, push fence, or publication ledger was found. | The operator or another tool owns commit, push, PR, merge, and recovery. |

## What Forge Should Retain

### Generate several runtime surfaces from one workflow source

Maestro avoids manually maintaining divergent Claude, Codex, Gemini, and Qwen
instructions. Forge could apply the same discipline to runtime-facing
methodology, adapter guidance, and skills while keeping enforcement in Forge
code.

### Keep a cheap and an enforced workflow path

The Express and Standard split is a good product shape. Small, supervised work
can use a lighter path; larger or unattended work earns stronger planning and
review ceremony. Forge should continue separating flexible playbooks from
correctness-bearing enforced workflows.

### Make reconciliation explicit

Maestro does not pretend that files prove their own provenance after a crash.
Its instruction to scan, attribute, and ask when uncertain is appropriate. A
Forge implementation should automate more of that process but preserve the
same honesty.

## What Forge Should Not Copy

- Shared-checkout parallel agents guarded only by planned file ownership.
- Read-modify-write session state without locking or compare-and-set.
- Direct-file fallback for state transitions when the state service is absent.
- Prompt-level review rules presented as equivalent to runtime enforcement.
- Completion without a native publication and recovery contract.

## Verdict

**Eligible and worth studying, but adjacent to Forge rather than a replacement.**

Maestro could improve how Forge expresses portable roles, playbooks, planning,
and review methodology. It cannot safely own Forge's concurrent execution or
publication lifecycle. If trialed, it should run inside a disposable worktree
or on work where a separate system already supplies isolation and authority.

## Primary Evidence

- [Project overview, runtime targets, installation, workflow, and security](https://github.com/josstei/maestro-orchestrate/blob/4f5d434dded8a5e58808ad60f56c6e410f57cf7e/README.md)
- [Codex runtime: MCP server, delegation, missing hooks, and missing policy enforcement](https://github.com/josstei/maestro-orchestrate/blob/4f5d434dded8a5e58808ad60f56c6e410f57cf7e/docs/runtime-codex.md)
- [Atomic file-write helper](https://github.com/josstei/maestro-orchestrate/blob/4f5d434dded8a5e58808ad60f56c6e410f57cf7e/src/lib/io/index.js)
- [Read-modify-write session-state helper](https://github.com/josstei/maestro-orchestrate/blob/4f5d434dded8a5e58808ad60f56c6e410f57cf7e/src/mcp/handlers/session-state-core.js)
- [Parallel execution and recovery methodology](https://github.com/josstei/maestro-orchestrate/blob/4f5d434dded8a5e58808ad60f56c6e410f57cf7e/src/skills/shared/execution/SKILL.md)
- [Apache-2.0 license](https://github.com/josstei/maestro-orchestrate/blob/4f5d434dded8a5e58808ad60f56c6e410f57cf7e/LICENSE)
