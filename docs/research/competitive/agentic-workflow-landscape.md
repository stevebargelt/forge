# Open Agentic Workflow Landscape

**Research snapshot:** 2026-07-24

This is the filtered landscape of agentic coding workflow products that could
plausibly replace, challenge, or inform Forge. It is research evidence, not a
binding product decision or an automatic source of backlog work.

## Hard Eligibility Filter

A candidate remains in the shortlist only when all three conditions hold:

1. **Open source:** the workflow product is available under an OSI-style
   open-source license, not merely source-available.
2. **No required product fee:** it can be run without buying the workflow
   vendor's license, hosted service, or paid tier. The Claude, ChatGPT, or
   compute subscription the operator chooses is excluded from this test.
3. **No Python implementation:** Python-based candidates are set aside for
   this evaluation.

These conditions are intentionally stricter than the original landscape.
Products can still be useful research references after elimination, but they
are no longer migration candidates.

## Filtered Shortlist

| Rank | Product | License and stack | Bottom line for Forge |
|---:|---|---|---|
| 1 | [Stoneforge](stoneforge-forge-assessment.md) | Apache-2.0; TypeScript/JavaScript, Bun/Node, React, SQLite | Closest complete overlap: tasks, worktrees, recovery, review, and merge. Strongest pilot candidate, but correctness gaps block migration. |
| 2 | [Agent Orchestrator](agent-orchestrator-forge-assessment.md) | Apache-2.0; Go daemon/CLI plus Electron/TypeScript | Strong lifecycle, state, worktree, and operator benchmark. Shared tmux, locked-worktree cleanup, broad permissions, and missing final merge block adoption. |
| 3 | [Maestro](maestro-forge-assessment.md) | Apache-2.0; JavaScript/Node and generated workflow artifacts | Best portable playbook reference. Shared-checkout execution and prompt-level gates make it adjacent rather than a safe execution substrate. |
| 4 | [Claude Squad](claude-squad-forge-assessment.md) | AGPL-3.0; Go | Useful thin worktree/session baseline. It lacks workflow and publication authority and recreates the host-wide tmux blast radius. |

The ranking reflects architectural relevance and readiness for Forge's failure
model, not popularity or polish.

## Filtered Out

| Product | Filter result | Why it is out |
|---|---|---|
| [Bernstein](https://github.com/sipyourdrink-ltd/bernstein) | Python | Open and safety-oriented, but excluded by the current language preference. |
| [Conductor](https://www.conductor.build/) | Closed source and paid | Polished subscription and Bedrock benchmark, but the application is proprietary and requires a paid product. |
| [Superset](https://github.com/superset-sh/superset) | Source-available and paid features | Elastic License 2.0 is not open source. Remote workspaces and other capabilities are gated behind Pro; pricing lists a paid per-user tier. |
| [AQ](https://aq.dev/) | Closed source and paid | Proprietary managed execution product with subscription pricing. |
| [GitHub Agent HQ](https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/) | Closed source and paid entitlement | Hosted proprietary control plane using GitHub Copilot entitlements rather than existing Claude or ChatGPT subscriptions. |
| [GitHub Agentic Workflows](https://github.com/github/gh-aw) | Incremental paid dependency | The extension is open, but practical hosted execution requires Copilot plans, GitHub entitlements, tokens, or separately billed API paths. |
| [OpenAI Codex product surface](https://openai.com/codex/) | Partly closed | The CLI is open source, but the wider hosted/app surface is proprietary and is a provider-specific agent rather than a provider-neutral Forge replacement. |
| CrewAI, LangGraph, AutoGen, and similar frameworks | Python and wrong product category | API-first libraries for building an orchestrator, not drop-in subscription-backed coding workflow products. |

### Superset finding

Superset originally looked eligible because its Electron and TypeScript source
is public. The repository is explicitly “Source Available” under Elastic
License 2.0. That license restricts managed-service use and license-key
circumvention and is not an open-source license. Its pricing also places remote
workspaces and broader collaboration in paid tiers. It is therefore a hard
elimination, not a lower-ranked candidate.

Some implementation ideas remain useful—worktree-per-workspace, terminal
handoff, and provider configuration—but they should be treated as observations
from an eliminated competitor.

## Authentication Terminology

Subscription sign-in, API credentials, and cloud-provider credentials are
different billing modes:

- **Claude subscription** means Claude Code or the Agent SDK uses a Claude Pro
  or Max account. `ANTHROPIC_API_KEY` is separately billed API use.
- **Codex subscription** means Codex uses ChatGPT sign-in. `OPENAI_API_KEY` is
  separately billed API use.
- **Bedrock** means Claude uses AWS credentials and Amazon Bedrock. Bedrock is
  metered even when the workflow product itself is free.
- **Pass-through** means the workflow launches an already authenticated CLI or
  SDK. It does not transform API billing into subscription access.
- **Unverified** means the underlying CLI appears capable of the path, but the
  workflow product does not document and test its environment and credential
  propagation.

## Provider Compatibility

| Product | Claude Pro/Max | Codex via ChatGPT | Claude via Bedrock | Confidence and caveat |
|---|---|---|---|---|
| Stoneforge | Yes, through Claude Agent SDK or CLI authentication | Likely yes through installed `codex app-server`; documentation is stale and still mentions an API key | Unverified pass-through | Agent processes inherit the server environment. Bedrock remains metered and needs an end-to-end test. |
| Agent Orchestrator | Yes, through its installed Claude Code adapter | Yes, through its installed Codex adapter | Unknown | AO has no Bedrock documentation or test. Environment forwarding makes pass-through plausible, not verified. |
| Maestro | Yes, through the Claude Code host | Yes, through the Codex host | Unverified pass-through | The host runtime owns authentication and permissions. |
| Claude Squad | Yes, by launching authenticated Claude Code | Yes, by launching authenticated Codex; its API-key README advice is stale and optional | Unverified pass-through | It has no auth layer. Reuse of the default tmux server creates environment-freshness risk. |

The strict answer remains: the survivors do not all explicitly support and test
Bedrock. Existing Claude and ChatGPT subscription authentication is much better
supported because each product delegates to the installed agent runtime.

## Comparative Failure Matrix

Every deep dive used the same scenario: two parallel changes, one agent crash,
one rejected review, an application or host restart, and final publication.

| Capability | Stoneforge | Agent Orchestrator | Maestro | Claude Squad |
|---|---|---|---|---|
| Parallel filesystem isolation | Worktree per worker | Worktree per worker | Shared checkout; planned non-overlap only | Worktree per session |
| Durable authority | SQLite plus audit events and lagged JSONL export | SQLite session authority | Project Markdown state | One global JSON file plus Git/tmux |
| Agent crash | Resume or respawn in same worktree | Reaper records exit; explicit resume | Reconcile files and rerun phase | No failed state or automatic recovery |
| Daemon/app restart | Startup reconciliation | Adopts live tmux and reconciles missing runtimes | Reads project state and reruns | Works only if JSON and every tmux session remain valid |
| Host restart | Credible, but merge orphans and JSONL lag remain | Plausible, not end-to-end proven | State remains; processes do not | Dashboard restoration can fail because tmux is gone |
| Rejected review | Automated failure can create fixes; human PR closure stalls | Review/CI nudges, not deterministic mandatory gate | Prompt-level rework rule | Manual reprompt only |
| Final publication | Detached merge worktree and push, but concurrent merge race | Backend merge not implemented | No publication layer | Commit/push branch with hooks bypassed |
| Incident-specific tmux risk | No matching central dependency found in the inspected architecture | Uses host-wide default tmux server | Host-runtime dependent | Uses host-wide default tmux server; ships unscoped kill-server scripts |
| Overall scenario | Partial | Partial | Fail as execution substrate | Fail |

## Candidate Conclusions

### 1. Stoneforge

Stoneforge is the only filtered candidate with a near-complete Forge-shaped
model. Its strongest behavior is recovery into the same recorded worktree and
provider session, with a fresh agent fallback that preserves filesystem state.
Its detached merge worktree also keeps publication away from the running main
checkout.

Migration is blocked by invariants, not breadth:

- task assignment is not an atomic fenced claim;
- the merge status check is not compare-and-swap;
- simultaneous publication is not serialized or retried;
- human rejection can strand a task or abandon its branch;
- merge worktree cleanup can leak after a crash;
- agents inherit secrets and run with approvals and sandboxing disabled.

Stoneforge should be the first contained pilot. The pilot must be designed to
break these boundaries, not merely demonstrate a happy-path dashboard.

### 2. Agent Orchestrator

AO has the strongest lifecycle substrate after Stoneforge. SQLite authority,
worktrees by default, generation-fenced observations, dirty-work preservation
refs, reaping, and daemon reconciliation are all credible and directly useful
comparisons.

The current product is primarily a session and worktree supervisor. Its LLM
orchestrator is not a durable deterministic workflow engine, final backend
merge is unimplemented, and review triggering is not proven as an automatic
gate.

Two incident-specific defects are disqualifying today:

- AO uses the host-wide default tmux server;
- locked-worktree force cleanup can remove the directory while leaving a stale
  Git registration.

It merits a second contained pilot only after isolating its tmux socket and
protecting the machine from its default broad worker permissions.

### 3. Maestro

Maestro is the strongest playbook-layer reference, not a replacement runtime.
It generates Claude, Codex, Gemini, and Qwen workflows from one canonical
source and provides an approachable Express-versus-Standard workflow split.

Its state is inspectable project documentation, but concurrent updates are
unlocked read-modify-write operations. Parallel agents share one checkout.
Codex has no hooks or policy enforcement, and the documented fallback allows
direct state-file operations when the MCP server is absent.

Forge should study Maestro's workflow portability and methodology generation
while keeping isolation, state transitions, gates, and publication in Forge.

### 4. Claude Squad

Claude Squad is a compact proof that worktree-per-session can be the ordinary
default in a small Go TUI. That is its primary value.

It fails the deeper Forge contract: non-atomic JSON state, no durable failed or
rejected-review transition, no host-restart recovery, no merge authority, and
commit/push with Git hooks bypassed.

More importantly, it uses the shared host tmux server and includes developer
cleanup scripts with unscoped `tmux kill-server`. That repeats the resource
ownership mistake behind the July 2026 Forge incident. It is a comparator, not
an adoption candidate.

## Recommended Pilots

Only the first two justify executable pilots now.

### Stoneforge pilot

Use a disposable repository and require proof of:

1. atomic assignment or a single-daemon fence;
2. uncommitted-change recovery after agent and daemon kill;
3. human rejection returning to the same branch and worktree;
4. simultaneous merge serialization or automatic retry;
5. locked and crash-orphaned worktree recovery;
6. real Claude and ChatGPT subscription sign-in;
7. Bedrock environment propagation if still desired;
8. reduced permissions and secret isolation;
9. state recovery when SQLite is lost inside the JSONL debounce window.

### Agent Orchestrator pilot

Use a disposable repository and private tmux server. Require proof of:

1. poisoned-tmux isolation;
2. locked-worktree cleanup;
3. crash, explicit resume, daemon restart, and host reboot;
4. rejected-review iteration;
5. subscription authentication and telemetry disablement;
6. final publication behavior, including the currently missing merge path;
7. restrictions that prevent host-wide Codex access.

Maestro and Claude Squad need no executable Forge-replacement pilot. Their
documented architecture is sufficient to classify them as adjacent references.

## Standing Decision

No candidate currently justifies switching away from Forge on trust and
correctness grounds.

This is not a defense of Forge's recent failures. The comparison instead makes
the required standard explicit: a replacement must do more than isolate happy
path sessions. It must remain honest across crashes, shared host resources,
rejected work, restart, and final publication.

Stoneforge and AO are worth testing because they expose enough implementation
to validate those claims. Neither passes the complete scenario yet.

## Primary Sources

- Stoneforge:
  [source](https://github.com/stoneforge-ai/stoneforge),
  [assessment](stoneforge-forge-assessment.md),
  [orchestration loop](https://docs.stoneforge.ai/core-concepts/orchestration-loop/),
  and [sync and merge](https://docs.stoneforge.ai/core-concepts/sync-and-merge/).
- Agent Orchestrator:
  [source](https://github.com/AgentWrapper/agent-orchestrator),
  [assessment](agent-orchestrator-forge-assessment.md),
  and [architecture](https://github.com/AgentWrapper/agent-orchestrator/blob/30bd3d2ddc5679e3bc00a2ce8a42046ca46db27e/docs/architecture.md).
- Maestro:
  [source](https://github.com/josstei/maestro-orchestrate),
  [assessment](maestro-forge-assessment.md),
  and [Codex runtime](https://github.com/josstei/maestro-orchestrate/blob/4f5d434dded8a5e58808ad60f56c6e410f57cf7e/docs/runtime-codex.md).
- Claude Squad:
  [source](https://github.com/smtg-ai/claude-squad),
  [assessment](claude-squad-forge-assessment.md),
  and [tmux implementation](https://github.com/smtg-ai/claude-squad/blob/5a604f76fc943d29fbc1ee76ec33b4ebd03178e3/session/tmux/tmux.go).
- Superset elimination:
  [license](https://github.com/superset-sh/superset/blob/7bcdd65ce3e3e828f40bed5b0be97bb30080fcf8/LICENSE.md)
  and [pricing](https://superset.sh/pricing).
