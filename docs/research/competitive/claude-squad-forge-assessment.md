# Claude Squad Assessment Compared to Forge

Date: 2026-07-24

Project: [`smtg-ai/claude-squad`](https://github.com/smtg-ai/claude-squad)

Snapshot inspected:
[`5a604f76fc943d29fbc1ee76ec33b4ebd03178e3`](https://github.com/smtg-ai/claude-squad/tree/5a604f76fc943d29fbc1ee76ec33b4ebd03178e3).

## Executive Take

Claude Squad passes the current eligibility filter:

- AGPL-3.0 open-source license;
- no required Claude Squad product or service fee;
- Go implementation, not Python;
- launches Claude Code, Codex, Gemini, Aider, or an arbitrary configured
  program;
- gives every session its own Git worktree and branch.

It is a useful minimum baseline for safe local parallel agent sessions. It is
not a Forge replacement. Claude Squad supervises terminals and worktrees; it
does not model durable tasks, dependencies, evidence gates, rejected-review
rework, merge authority, or publication recovery.

Recommended disposition:

1. Retain it as the compact worktree/session-manager baseline.
2. Borrow its immediate worktree-per-session product default.
3. Do not deploy it alongside Forge until it uses a private tmux socket.
4. Do not infer workflow safety from tmux persistence or a diff preview.
5. Do not use its commit-and-push path as Forge publication.
6. Treat its Bedrock path as requiring a live test.

## Eligibility

| Requirement | Result | Evidence |
|---|---|---|
| Open source | Pass | AGPL-3.0 license. |
| No required product fee | Pass | Public source and free Homebrew/manual installation; no paid Claude Squad tier was found. |
| No Python | Pass | Go implementation. |

The operator still pays for whichever coding-agent subscription or compute
provider they select. AGPL permits ordinary local use and private
modification, but a modified network service would carry the license's source
offer obligation.

## Product Model

Claude Squad is a terminal UI over tmux and Git worktrees:

```text
Claude Squad TUI
       |
       +--> session state JSON
       |
       +--> tmux session --> Claude/Codex/other CLI
       |
       +--> Git worktree --> task branch
```

The operator can create, attach, pause, resume, kill, preview diffs, check out
changes, and commit and push a session branch. This is a coherent interactive
session model. It does not know why the session exists, what acceptance
criteria apply, whether evidence is sufficient, or whether another system may
publish the branch.

## Worktree Safety

Every new session receives a unique worktree and branch based on committed
`HEAD`. Concurrent sessions therefore do not share a mutable checkout. This is
the strongest reason Claude Squad remains in the deep-dive set.

The model has important boundaries:

- uncommitted changes in the operator's original checkout are not included in
  the new session;
- pausing commits dirty work before removing the worktree so the branch can be
  recreated;
- killing a session can force-remove its worktree and, for a generated branch,
  force-delete the branch after operator confirmation;
- the UI removes durable instance state before cleanup completes, and a cleanup
  error is logged after the instance has disappeared from the list.

This is effective interactive isolation, but cleanup safety depends heavily on
the operator understanding the destructive action. Kill does not protect dirty
or unpushed work, and there is no publication lease or external ownership check
before a branch is deleted.

## Shared tmux Server Hazard

Claude Squad uses the host's default tmux server. Its tmux commands do not
select a private socket with `tmux -L`. The repository also contains developer
cleanup scripts whose first action is an unscoped `tmux kill-server`.

Those scripts are not part of the normal UI path, but they expose the
underlying ownership mistake: Claude Squad treats a shared host daemon as
though it belongs to this application.

This is directly relevant to Forge's July 2026 incident. A default tmux server
can preserve a deleted fixture directory as its current working directory,
poison later launches, or be killed along with unrelated sessions. Any trial
would first require a dedicated tmux socket and tests proving that application
cleanup cannot affect the host server.

## State and Process Recovery

Claude Squad stores configuration and instance data as JSON. State writes use
`os.WriteFile` directly rather than a temporary-file rename. A state read or
JSON parse failure returns default empty state. Corruption can therefore make
existing instances disappear from the UI instead of producing a fail-closed
recovery path.

tmux lets agent processes survive closing and reopening the TUI. Existing tmux
sessions can be rediscovered from saved instance state. This covers an
application restart well.

It does not cover an agent crash or host reboot. A missing tmux session makes
instance restoration fail; during application startup, one failed instance
load aborts the whole application. Claude Squad has no durable process journal,
automatic attempt relaunch, or reconciliation protocol. Branches and worktrees
remain, but the dashboard can be bricked until the operator repairs state.

Status observation is based on tmux pane output, hashes, and recognizable
prompt strings rather than structured, durable agent events. That is adequate
for navigation, not proof of task completion.

## Review and Publication

The UI's diff preview and “review changes before applying them” language
describe a human review surface, not a workflow gate.

Claude Squad has no formal review verdict object, rejection state, required
rework transition, evidence ledger, or independent reviewer authority. If a
reviewer rejects a change, the operator must return to the session and direct
the rework.

Its push action stages all changes, creates a commit with Git hooks disabled,
and pushes the branch. Bypassing hooks with `--no-verify` is particularly
unsuitable for Forge's correctness-bearing publication path. The action then
opens the remote branch URL; it does not create or merge a pull request, wait
for CI, fence stale publication, or recover an interrupted merge.

## Authentication

| Path | Assessment |
|---|---|
| Claude Pro/Max subscription | Expected through the already authenticated `claude` program. |
| Codex through ChatGPT subscription | Works through an already authenticated `codex`; Claude Squad's `OPENAI_API_KEY` README instruction is a stale optional path, not a product requirement. |
| Claude through Amazon Bedrock | Inferred if the launched Claude Code process inherits a working Bedrock configuration and AWS credentials; no Claude Squad-specific documentation or test was found. |

The distinction is important: Claude Squad is a generic launcher. It does not
itself implement or certify these authentication modes. Its reuse of a
pre-existing default tmux server also makes Bedrock environment freshness a
specific concern.

## Fixed Failure Scenario

| Event | Claude Squad behavior | Operator burden or gap |
|---|---|---|
| Two parallel changes | Each receives an isolated worktree and branch. | Strong filesystem isolation; no dependency or ownership scheduler. |
| One agent crashes | Branch and worktree remain. | No failed status or restart path; a missing tmux session can make the next application startup fail. |
| Review rejects a change | Human can return to the session and request changes. | No rejection state, automatic rework loop, or evidence gate. |
| Application restarts | Saved state plus live tmux sessions normally restores the UI. | JSON corruption fails open to empty state. |
| Host restarts | Worktrees and branches survive. | tmux agents do not; restoring missing sessions can abort application startup. |
| Final publication | A command commits all changes and pushes the branch. | Hooks are bypassed; no PR, CI, merge, fencing, or publication recovery. |

## What Forge Should Retain

### Make isolation the ordinary session-creation path

Claude Squad does not ask the operator to remember a special safety mode. A
new agent session means a new worktree. That is the right default for any tool
encouraging parallel mutation.

### Separate pause from delete

Pause preserves dirty work on a branch and frees the worktree; delete is an
explicitly destructive operation. Forge should preserve that product
distinction while applying stricter publication and recovery ownership checks.

### Keep the smallest useful operator surface

The TUI focuses on session list, live output, diff, attach, pause, and resume.
It is a useful reminder that a reliable low-level session supervisor need not
also invent a complex workflow vocabulary.

## What Forge Should Not Copy

- Direct, non-atomic JSON state writes with parse failure mapped to empty state.
- Use of the shared host tmux server and unscoped `tmux kill-server` scripts.
- tmux screen scraping as authoritative task status.
- Branch deletion without an external publication or recovery ownership check.
- Commit and push with `--no-verify`.
- “Review” without a durable verdict and rework transition.
- Treating a surviving worktree as proof that a crashed attempt is understood.

## Verdict

**Eligible and useful as a baseline, but substantially below Forge's intended
workflow contract.**

Claude Squad proves that worktree-by-default parallel CLI supervision can be
small, understandable, and free. It cannot replace Forge's durable
orchestration, review evidence, or publication machinery, and its shared tmux
server design makes it unsuitable to run beside Forge without remediation.

## Primary Evidence

- [Overview, worktree model, supported programs, actions, and license](https://github.com/smtg-ai/claude-squad/blob/5a604f76fc943d29fbc1ee76ec33b4ebd03178e3/README.md)
- [JSON state load and direct-write behavior](https://github.com/smtg-ai/claude-squad/blob/5a604f76fc943d29fbc1ee76ec33b4ebd03178e3/config/state.go)
- [Worktree creation and cleanup](https://github.com/smtg-ai/claude-squad/blob/5a604f76fc943d29fbc1ee76ec33b4ebd03178e3/session/git/worktree_ops.go)
- [Session load and restore behavior](https://github.com/smtg-ai/claude-squad/blob/5a604f76fc943d29fbc1ee76ec33b4ebd03178e3/session/storage.go)
- [Default-server tmux operations](https://github.com/smtg-ai/claude-squad/blob/5a604f76fc943d29fbc1ee76ec33b4ebd03178e3/session/tmux/tmux.go)
- [Unscoped tmux cleanup script](https://github.com/smtg-ai/claude-squad/blob/5a604f76fc943d29fbc1ee76ec33b4ebd03178e3/clean.sh)
- [Commit and push behavior](https://github.com/smtg-ai/claude-squad/tree/5a604f76fc943d29fbc1ee76ec33b4ebd03178e3/session/git)
- [AGPL-3.0 license](https://github.com/smtg-ai/claude-squad/blob/5a604f76fc943d29fbc1ee76ec33b4ebd03178e3/LICENSE.md)
