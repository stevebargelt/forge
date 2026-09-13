# agent-harness Assessment Compared to Forge

Date: 2026-09-13

Project: [`BA-CalderonMorales/agent-harness`](https://github.com/BA-CalderonMorales/agent-harness)

Snapshot inspected:
[`428cf0a616867ddb9e062e5bb4df075a93c82ccf`](https://github.com/BA-CalderonMorales/agent-harness/tree/428cf0a616867ddb9e062e5bb4df075a93c82ccf)
(default branch `main`, version line v0.3.34).

## Executive Take

agent-harness passes the current eligibility filter:

- permissive open-source license (see the license caveat below);
- no required product fee — free, and local-first by default;
- Go implementation, not Python.

But it is a different **kind** of thing from every other subject in this index.
It is not an orchestrator. It is a single-user, single-process terminal coding
agent — in its own words "a clean-room, pattern-derived agent harness for
building coding agents"
([README](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/README.md)).
It drives models directly over an OpenAI-compatible/Anthropic HTTP client; it
does not launch, supervise, or schedule other agents across isolated
workspaces. On Forge's axes it overlaps almost nowhere, because it sits at the
layer Forge *dispatches* — it is a peer to Claude Code or Codex, the worker,
not to Forge, the control plane.

Read that way it is a competent, legible worker: an encrypted provider-agnostic
credential store, a local-first default that needs no API key, and a clean
append-only session transcript. It has no durable task/run identity, no
worktree or container isolation for delegated work, no review verdict or
evidence ledger, and no publication authority separate from a raw
`git commit`/`gh pr create` on the operator's live checkout.

Recommended disposition:

1. Classify it as a worker/harness, not an orchestrator candidate — it is not
   a Forge alternative and does not belong in the pilot ranking beside
   Stoneforge.
2. Retain its encrypted `secret://` credential-indirection pattern and its
   local-first default as ideas.
3. Do not treat its in-process path allowlist as an isolation model.
4. Do not treat its command-approval prompt as a review gate.
5. Do not treat its commit/PR passthrough as publication.

## Eligibility

| Requirement | Result | Evidence |
|---|---|---|
| Open source | Pass | Permissive license present; free public source. See caveat. |
| No required product fee | Pass | Free install; local-first default runs a llama.cpp GGUF with no key ([README Quick Start](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/README.md)). |
| No Python | Pass | Go 1.26 module ([README](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/README.md)). |

**License caveat.** The repository's
[`LICENSE`](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/LICENSE)
carries the Apache-2.0 short notice ("Copyright 2025 Brandon A. Calderon
Morales"), while the
[README](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/README.md)
declares MIT in both its badge and its footer, and GitHub's own detector
reports `NOASSERTION`/"Other" because the file is only the notice, not the full
license text. Both candidate licenses are permissive and OSI-approved, so
eligibility is not in doubt — but the disagreement is a real clarity defect a
downstream adopter would have to resolve before redistributing.

The operator still pays for whichever hosted provider they select; the
local-first default avoids that entirely at some quality cost.

## Product Model

agent-harness is a Bubble Tea terminal UI wrapped around one live agent loop:

```text
TUI (Home / Chat / Sessions / Settings)
       |
       +--> agent loop (streaming executor, tool calls)
       |        |
       |        +--> OpenAI-compatible / Anthropic HTTP client
       |        +--> builtin tools (bash, read/write/edit, grep, git, agent, ...)
       |
       +--> per-project append-only JSONL session ledger
       +--> encrypted credential store (~/.config/agent-harness/credentials.enc)
```

Everything happens inside one process, against the operator's current working
directory. There is no daemon, no queue, no scheduler, no second worker. A
`agent` builtin tool can spawn an in-process sub-agent with fresh context, but
it shares the same working tree and is capped only by a recursion depth of five
([agent.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/internal/runtime/tools/builtin/agent.go#L10-L64),
wired at
[agent_turn.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/cmd/agent-harness/agent_turn.go#L73-L75)).
This is the Claude-Code `Task`-tool shape, not the isolate-and-orchestrate
shape.

## Work Representation and State

Work is a **session**, not a durable task or run. State is an append-only JSONL
file per session, grouped by project directory, with a self-describing
timestamped filename so `ls` reads like a history — the comment even notes this
is "the layout Pi uses"
([session_store.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/internal/core/state/session_store.go#L14-L57)).
User messages are written blocking and fsynced, so a crash loses at most the
last line
([persistence.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/internal/core/state/persistence.go#L27-L47)).

This is a clean, legible transcript, but it is a transcript, not a control
plane. There is no task/attempt lifecycle, no status vocabulary, no dependency
or blocker model, no assignment or claim, and nothing that another process
could reconcile against. Compare Forge, where SQLite is the source of
lifecycle truth and artifacts are evidence for a row's state, not the state
itself (`docs/invariants.md`, invariant 1).

## Isolation and Concurrency

There is effectively none at the OS level. The `pkg/sandbox` "sandbox" is an
in-process path allowlist (`IsPathAllowed`) plus a small substring denylist of
dangerous commands (`IsDangerousCommand`, matching literals like `rm -rf /`
and `curl | sh`)
([sandbox.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/pkg/sandbox/sandbox.go#L18-L67)).
Both run in the same process as the agent, against the operator's real
checkout, and the denylist is trivially bypassable (any wrapping, aliasing, or
unlisted destructive command passes). It is a guardrail, not a boundary.

Git worktree helpers exist
([git.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/pkg/git/git.go#L155-L182))
and are exposed as an operator `/worktree` slash command — but they are a
manual convenience, not an isolation mechanism assigned to parallel work.
Delegated sub-agents run in-process and share the one working directory. So
there is no story for two changes in flight at once: they would collide in a
single mutable checkout. This is the opposite of Forge's default, where a
mutating agent gets a private `git clone --shared` at the recorded base SHA
with the parent object store mounted read-only, and reds are mounted `:ro` at
the container level (`docs/invariants.md`, invariants 9, 18, 19).

## Review and Publication

"Review" is interactive command approval, not a workflow gate. Before a
potentially dangerous tool call the UI shows the command and offers Approve /
Approve-All / Reject / Reject-and-Suggest, or a yolo mode that auto-approves
with visibility
([command-approval.md](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/docs/command-approval.md)).
Reject-and-Suggest steers the same live agent. There is no durable review
verdict object, no rejection/rework state transition, no independent reviewer
authority, and no evidence ledger — none of the structure Forge's
evidence-led review model depends on (`docs/invariants.md`, invariants 6, 11).

Publication is a raw Git/`gh` passthrough on the operator's live checkout:
`Commit` runs `git commit`, `CreateBranch` runs `git checkout -b`, and
`CreatePR` shells `gh pr create`
([git.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/pkg/git/git.go#L57-L152)).
There is no candidate built in a throwaway worktree, no gate or test run before
the ref moves, no compare-and-swap publication window, no CI wait, and no
fencing of a stale publisher — exactly the machinery Forge treats as the whole
point of a publisher (`docs/invariants.md`, invariants 13, 14). The commit
lands directly on whatever branch the operator is standing on.

## Authentication

| Path | Assessment |
|---|---|
| Claude Pro/Max subscription | **No.** Anthropic is reached as a direct `https://api.anthropic.com/v1` client with a bearer API key ([client.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/internal/runtime/llm/client.go#L52-L95)). An API key is usage-billed and is not subscription sign-in. |
| Codex via ChatGPT subscription | **No.** No Codex/ChatGPT integration exists; there is no OAuth flow. `/login` only stores an API key. |
| Claude via Amazon Bedrock | **No / not evidenced.** No Bedrock base URL, no AWS credential handling, no documentation. |

What it does authenticate is a broad set of key-based providers — local
llama.cpp/Ollama (no key), NVIDIA, OpenRouter, OpenAI, Anthropic, Fireworks,
Omniroute
([client.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/internal/runtime/llm/client.go#L52-L82),
[supported_models.md](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/docs/supported_models.md)).
Keys live in an encrypted store (AES-256-GCM, Argon2id, `0600`) and may be
sourced indirectly with `secret://env:`, `secret://file:`, or `secret://cmd:`
references resolved at boot
([credentials.md](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/docs/credentials.md)).
This is a clean confirming example of the index's standing caveat that a
direct provider API key is a different mode from subscription sign-in.

## Fixed Failure Scenario

| Event | agent-harness behavior | Operator burden or gap |
|---|---|---|
| Two parallel changes | No concurrency model; one session on one working directory. A delegated sub-agent shares that same checkout ([agent.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/internal/runtime/tools/builtin/agent.go#L10-L64)). | No isolation or scheduler; genuinely parallel edits would collide in one checkout. |
| One agent crashes | Session JSONL is append-only and fsynced on user messages, so at most the last line is lost ([persistence.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/internal/core/state/persistence.go#L27-L47)). | No durable task/attempt, no failed status, no automatic relaunch; operator resumes the session manually. |
| Review rejects a change | Command approval lets the human reject or reject-and-suggest to the live agent ([command-approval.md](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/docs/command-approval.md)). | No durable verdict, rework transition, or evidence ledger. |
| Application restarts | Per-project session files persist and reload via `/session`. | Fine for one interactive session; nothing to reconcile because nothing else was running. |
| Host restarts | No daemon; working tree, branches, and session files survive on disk. | No in-flight agent work is durable across a reboot — there is none to lose, and nothing resumes autonomously. |
| Final publication | `git commit` / `git checkout -b` / `gh pr create` directly on the operator's checkout ([git.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/pkg/git/git.go#L57-L152)). | No candidate, gate, CAS, CI wait, or fencing; commit lands on the live branch. |

The scenario the other assessments stress — unattended, concurrent, recoverable
execution to a validated publication — is simply out of scope here.

## Maturity

At the inspected snapshot the repository was young and single-author:

- created 2026-04-01; last push 2026-09-09 (actively developed);
- 16 stars, 3 forks, 0 open issues (GitHub API);
- 32 release tags through v0.3.34, with a bump/release CI flow;
- essentially one contributor (Brandon Calderon-Morales across name variants);
- ~459 Go files and ~177 `*_test.go` files — tests mirror sources, and CI
  shards them (tui / core / rest) with a race lane
  ([ci.yml](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/.github/workflows/ci.yml));
- `internal/loop/` is a "modular bucket rewrite (not yet the live path)" per
  [AGENTS.md](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/AGENTS.md)
  — documented-ahead-of-implementation, the same young-project signal noted
  for Stoneforge.

The engineering discipline is notable for the size: one concept per file, a
≤400-line budget that `make verify` measures, and a well-tested tool layer.

## What Forge Should Retain

### Provider-agnostic encrypted credentials with `secret://` indirection

Keys never sit in plaintext config or session files; they live in an
AES-256-GCM/Argon2id store, and any `api_key` value can be a
`secret://env:` / `secret://file:` / `secret://cmd:` reference resolved at
boot, which wraps any external secrets manager without an SDK
([credentials.md](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/docs/credentials.md)).
Forge resolves auth per runtime; the `secret://cmd:` escape hatch is a clean,
portable pattern for sourcing provider keys from an operator's own manager
without Forge learning each vendor.

### A local-first default that needs no key

The checked-in default targets a local llama.cpp GGUF endpoint, so the tool
runs fully offline with zero credential and zero API cost
([README](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/README.md),
[supported_models.md](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/docs/supported_models.md)).
As a low-cost, low-blast-radius option for exercising a worker runtime, this is
worth keeping in mind for Forge's runtime catalog.

### A legible, crash-tolerant transcript

Append-only JSONL, per-project grouping, self-describing timestamped
filenames, and fsync-on-user-message give a transcript that `ls` reads like a
history and a crash truncates by at most one line
([session_store.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/internal/core/state/session_store.go#L14-L57)).
Forge's SQLite authority is stronger, but the human legibility of the on-disk
form is a nice property for any exported evidence surface.

## What Forge Should Not Copy

- An in-process path allowlist plus a substring denylist presented as a
  "sandbox" — it runs in the agent's own process against the real checkout and
  is trivially bypassable ([sandbox.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/pkg/sandbox/sandbox.go#L18-L67)). A read-only container mount is the boundary.
- Sub-agents that share the operator's live working directory with only a
  recursion cap and no isolation ([agent.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/internal/runtime/tools/builtin/agent.go#L10-L64)).
- Publication as a raw `git commit` / `gh pr create` on the live checkout with
  no candidate, gate, CAS, or fencing ([git.go](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/pkg/git/git.go#L57-L152)).
- "Review" as an execution-time approval prompt with no durable verdict or
  rework transition ([command-approval.md](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/docs/command-approval.md)).
- Session-transcript-as-authority: a JSONL log is evidence, not a lifecycle
  control plane.
- License ambiguity: an Apache notice, an MIT README, and a NOASSERTION
  detection should not coexist in a project meant to be redistributed.

## Verdict

**Eligible, but a worker, not an orchestrator — not a Forge alternative.**

agent-harness is a tidy, actively developed, single-author terminal coding
agent that talks directly to models over API keys or a local endpoint. It is
the layer Forge dispatches, not a competitor to Forge's control plane: it has
no durable task/run identity, no isolation for parallel work, no review
verdict or evidence ledger, and no publication authority separate from a raw
commit on the operator's checkout. Its worthwhile ideas are small and
local — an encrypted, provider-agnostic credential store with `secret://`
indirection, and a zero-key local-first default. It belongs in this index as a
worker/harness reference point, not in the orchestrator pilot ranking.

## Primary Evidence

- [Overview, install, layout, provider examples, MIT footer](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/README.md)
- [LICENSE file (Apache-2.0 short notice)](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/LICENSE)
- [In-process path allowlist and dangerous-command denylist](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/pkg/sandbox/sandbox.go#L18-L67)
- [Git commit / branch / PR / worktree helpers](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/pkg/git/git.go#L57-L182)
- [Append-only JSONL session store layout](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/internal/core/state/session_store.go#L14-L57)
- [Blocking fsync persistence](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/internal/core/state/persistence.go#L27-L47)
- [Provider base URLs and bearer-key auth](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/internal/runtime/llm/client.go#L52-L95)
- [In-process sub-agent tool, recursion depth 5](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/internal/runtime/tools/builtin/agent.go#L10-L64)
- [Sub-agent wiring in the turn loop](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/cmd/agent-harness/agent_turn.go#L73-L75)
- [Encrypted credential store and secret:// indirection](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/docs/credentials.md)
- [Command approval modes](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/docs/command-approval.md)
- [Provider/model matrix](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/docs/supported_models.md)
- [Sharded CI workflow](https://github.com/BA-CalderonMorales/agent-harness/blob/428cf0a616867ddb9e062e5bb4df075a93c82ccf/.github/workflows/ci.yml)
