# Strands Agents Assessment Compared to Forge

Date: 2026-07-30

Projects:

- [`strands-agents/harness-sdk`](https://github.com/strands-agents/harness-sdk)
- [`strands-agents/evals`](https://github.com/strands-agents/evals)
- [`strands-agents/shell`](https://github.com/strands-agents/shell)

Snapshots inspected:

- Harness SDK
  [`526692f53d403522a650a926a9332d7b2272cfaa`](https://github.com/strands-agents/harness-sdk/tree/526692f53d403522a650a926a9332d7b2272cfaa);
  TypeScript package 1.11.2.
- Evals
  [`0bf12520908fcf02ca39acaf11cd302587988787`](https://github.com/strands-agents/evals/tree/0bf12520908fcf02ca39acaf11cd302587988787);
  version 1.0.3.
- Shell
  [`7b17af3a6ba8e6ae3bec444bb45d3f06958badc4`](https://github.com/strands-agents/shell/tree/7b17af3a6ba8e6ae3bec444bb45d3f06958badc4);
  version 0.3.2.

## Executive Take

Strands Agents is a credible, AWS-backed open-source toolkit for building
agents. It is not a Forge replacement.

Its strongest pieces are below Forge's product layer:

- model-provider adapters, with Amazon Bedrock as the default;
- TypeScript and Python agent loops;
- tool, MCP, hook, intervention, and structured-output primitives;
- Graph and Swarm multi-agent orchestrators;
- local-file and S3 session persistence;
- execution metrics, OpenTelemetry integration, and a separate evaluation
  framework;
- an in-process virtual shell with explicit filesystem, network, and
  credential policy.

It does not provide Forge's backlog, durable work queue, claims and leases,
Git/worktree isolation, coding-agent subscription adapters, acceptance
evidence, review ledger, CI authority, publication identity, or operator
dashboard.

The decisive authentication difference is that Strands calls model APIs. The
direct Anthropic provider requires an Anthropic API key, the direct OpenAI
provider requires an OpenAI API key, and the default Bedrock provider requires
AWS or Bedrock credentials. Claude Pro/Max and ChatGPT subscriptions are not
model-provider credentials for Strands.

Recommended disposition:

1. Classify Strands as an adjacent agent SDK and architectural reference, not
   a replacement candidate.
2. Do not replace Forge's subscription-backed Claude Code and Codex execution
   with Strands API calls.
3. Retain its deterministic-Workflow versus exploratory-Swarm distinction,
   coordinator-owned session state, execution metrics, and intervention
   surfaces as useful prior art.
4. Consider a later bounded assessment of the TypeScript metrics and Evals
   surfaces for offline prompt/reviewer evaluation.
5. Do not replace Forge's containers with Strands Shell.

## Eligibility and Product Category

| Requirement | Result | Evidence and caveat |
|---|---|---|
| Open source | Pass | Harness, Evals, and Shell use Apache-2.0. |
| No required Strands product fee | Pass | The SDKs are self-hostable; model inference and optional AWS infrastructure remain metered. |
| Usable without Python | Partial pass | The core harness has a real TypeScript SDK. Some ready-made orchestration, steering, guard, and evaluation capabilities remain Python-only or Python-first. |
| Subscription-backed coding agents | Fail | Built-in providers use API or cloud credentials, not Claude or ChatGPT subscription login. |
| Forge-shaped workflow product | Fail | Strands is an embeddable SDK family rather than an operator-facing software-delivery control plane. |

The TypeScript SDK is not a token wrapper around the Python package. It has
native Agent, model-provider, Graph, Swarm, storage, hook, metrics, structured
output, deployment, and Node runtime surfaces. It reached 1.0 on 2026-04-30
and 1.11.2 on 2026-07-27.

Language parity is incomplete. The documentation describes Workflow as a
pattern implemented by chaining agents and tasks, while Python has a ready-made
workflow tool that automatically handles dependencies and parallel execution.
Several homepage guard and steering examples are explicitly Python-only. Forge
should therefore evaluate each desired TypeScript capability rather than infer
parity from the dual-language documentation toggle.

## Architecture and Authority

Strands is an in-process agent harness:

```text
application
    |
    +--> Graph / Swarm / application-defined Workflow
    |           |
    |           +--> Agent loop --> model provider
    |                              |
    |                              +--> Bedrock
    |                              +--> Anthropic API
    |                              +--> OpenAI API
    |                              +--> other/custom provider
    |
    +--> local tools / MCP tools
    +--> hooks and interventions
    +--> session storage: local files or S3
    +--> metrics, traces, and logs
```

The host application remains the product and the authority. It decides what a
task is, when an agent runs, what tools it may call, how failure changes state,
what gets persisted, and what constitutes completion.

That is a useful foundation for building an agent application. It is not the
durable software-delivery system Forge would otherwise have to replace.

## Model Providers and Authentication

| Path | Strands support | Billing and authentication |
|---|---|---|
| Amazon Bedrock | First-class and default | AWS credentials, IAM role, Bedrock bearer token, model access, and metered Bedrock use. |
| Direct Anthropic | First-class | `ANTHROPIC_API_KEY`; separately billed Anthropic API use. |
| Direct OpenAI | First-class | `OPENAI_API_KEY`; separately billed OpenAI API use. |
| Claude Pro/Max subscription | No native path | A Claude subscription authenticates Claude Code, not the Anthropic API client Strands uses. |
| Codex through ChatGPT subscription | No native path | ChatGPT sign-in authenticates Codex, not the OpenAI API client Strands uses. |
| Other providers | Broad | Google, LiteLLM, llama.cpp, LlamaAPI, Mistral, Ollama, SageMaker, Vercel, Writer, and custom providers are documented. |

It would be possible to write a Strands tool or custom provider that launches
Claude Code or Codex. That would be a new integration owned by Forge, not
built-in subscription compatibility. It would also recreate process
supervision, streaming, cancellation, identity, recovery, and evidence
problems that Forge already solves directly.

## Multi-Agent Patterns

Strands distinguishes three patterns:

| Pattern | Execution authority | Best fit |
|---|---|---|
| Graph | Developer declares nodes and edges; model decisions choose among allowed paths. | Conditional processes and bounded cycles. |
| Swarm | Agents autonomously choose handoffs among a declared pool. | Exploration, brainstorming, and emergent collaboration. |
| Workflow | Developer declares a deterministic acyclic task graph; independent tasks run in parallel. | Repeatable production processes. |

This taxonomy supports Forge's current direction. Shipping software benefits
from a deterministic workflow and explicit state transitions. Swarms are more
appropriate for discovery where multiple perspectives are useful and no agent
opinion independently grants publication authority.

Graph and Swarm expose shared invocation state plus orchestrator state for node
results, progress, and application data. That state can be passed to tools
without placing it in the model prompt. This is a useful separation between
machine control state and model-visible context.

The abstraction is still below Forge's task model. Strands does not
automatically create isolated Git workspaces, prevent overlapping writes,
capture candidate commits, run project verification, disposition review
findings, or publish an exact reviewed tree.

## Persistence and Agent Communication

Strands supports local-file and S3 storage for sessions. For Graph and Swarm,
the orchestrator owns the session manager; child agents must not attach
independent session managers. The orchestrator snapshots and restores child
node state.

That ownership rule aligns with Forge's evidence-led coordinator: durable
workflow state belongs to the coordinator, while agents produce artifacts that
the coordinator validates and records.

It does not by itself solve Forge's durable-message problem. Session snapshots
are not a work queue, claim ledger, immutable FixBatch, finding ledger, or
append-only delivery record. A Forge integration would still need explicit
message identities, expected recipients, acknowledgements, retries, candidate
binding, and operator-visible failure state.

## Observability and Evaluations

Strands automatically records:

- input, output, total, and cache token usage;
- total duration and individual reasoning-cycle duration;
- tool call counts, success rates, and execution times;
- model-request latency;
- local execution traces;
- serializable per-invocation metrics.

This is strong prior art for Forge's runtime telemetry. FG-648 deliberately
starts at task-level runtime because subscription-backed coding CLIs do not
necessarily expose the same token and event-loop detail. Forge should not
delay that dashboard work waiting for SDK-level telemetry it does not receive.

The separate Evals SDK contains output, trajectory, interaction, correctness,
instruction-following, tool-selection, failure, recovery, deterministic, red
team, simulation, and chaos-testing evaluators.

The plausible Forge use is offline:

- compare reviewer prompts or model routes;
- measure finding precision and false closure;
- replay known incidents;
- evaluate lifecycle changes before making them authoritative.

An LLM evaluator should never replace deterministic project tests, acceptance
evidence, candidate identity, or the review-disposition gate.

I found no bundled local operator dashboard for managing arbitrary Strands
workflow runs. The SDK exposes metrics and OpenTelemetry data; AWS AgentCore
has an evaluation dashboard, but that is an AWS deployment/evaluation surface,
not a self-hosted Forge-shaped backlog and run-control UI.

## Security and Strands Shell

Ordinary Strands tools execute in the host application's process unless the
application supplies a separate sandbox. Hooks and interventions can inspect,
cancel, or redirect tool calls. Cedar authorization and human-intervention
surfaces are useful policy primitives, but their safety depends on attaching
them to every relevant action boundary.

Strands Shell is a separate Rust implementation exposed through Python, Node,
and MCP. It provides:

- a Bourne-compatible virtual shell;
- an in-memory virtual filesystem;
- explicit copy or direct host binds;
- URL allowlists and private-address SSRF protection;
- credentials injected per matching request rather than exposed to the agent;
- timeout, output, descriptor, and inode limits.

It is attractive because construction and commands avoid container startup and
process-fork overhead. It is not a Docker replacement for Forge:

- its own documentation calls it a mediation layer, not a hardened sandbox;
- it runs in the same process as the application;
- resource limits are best-effort rather than cgroup-enforced;
- adversarial tenants still require a container or microVM;
- its virtual commands cannot stand in for every compiler, package manager,
  native module, daemon, or project-specific test environment a coding agent
  may need.

A possible future use is a narrow read-only research or data-access surface.
Builders and tests should retain OS-level isolation.

## Operator Experience

Strands is developer-facing:

- source code defines agents, tools, graphs, swarms, and policies;
- local console output shows agent activity;
- metrics, traces, and logs are available programmatically or through
  telemetry infrastructure;
- deployment guidance targets AgentCore, Lambda, Fargate, App Runner, EKS,
  EC2, Docker, and Kubernetes.

It does not offer an out-of-the-box local operator experience equivalent to:

- a project backlog and work queue;
- run and task drill-down;
- attention and decision routing;
- capacity and lease visibility;
- candidate, review, CI, and publication provenance;
- recovery controls;
- a Kanban or workflow dashboard.

Those would remain Forge product work.

## Fixed Failure Scenario

The common comparison is two parallel code changes, one agent crash, one
rejected review, an application or host restart, and final publication.

| Event | Strands behavior | Assessment |
|---|---|---|
| Two parallel changes | Workflow or Graph can run independent agents concurrently. | No built-in Git/worktree isolation or overlapping-write prevention. |
| One agent crashes | Session state can be persisted locally or in S3; application code defines retry and recovery. | Useful primitives, but no coding-agent process/session and filesystem recovery contract. |
| Review rejects | A custom graph, hook, intervention, or application transition can route rework. | No built-in evidence-led code-review ledger or publication gate. |
| Host restarts | Persisted session state can be restored. | Application must reconcile processes, files, claims, Git state, and side effects. |
| Final publication | Application tools may commit, push, or call a PR API. | No candidate identity, trusted-tip, CI, merge, or publication authority is supplied. |

The scenario cannot be completed safely without rebuilding most of Forge
around the SDK.

## Maturity

The harness repository was created in May 2025 and is actively maintained by
an AWS-heavy contributor group. At inspection it had approximately 6,700
stars, 1,000 forks, hundreds of contributors and bots, and daily main-branch
activity.

The TypeScript SDK progressed from its first public package in November 2025
to 1.0 in April 2026 and 1.11.2 in July. The project documents semantic
versioning, deprecation, and explicit experimental namespaces. It also
acknowledges that MCP, A2A, and OpenTelemetry standards evolve quickly and
recommends pinning minor versions when using them.

This is materially more mature and better resourced than most Forge
replacement candidates. Its maturity does not change the product-category or
authentication mismatch.

## What Forge Should Retain

### Keep production paths deterministic

Use deterministic Workflow-shaped execution for correctness-bearing delivery.
Reserve Swarm-shaped collaboration for bounded discovery.

### Let the coordinator own durable state

Child agents should not each invent independent session truth. The coordinator
records state and validates their artifacts.

### Separate control state from prompt context

Invocation state available to tools and hooks need not be copied into model
prompts. Forge's durable IDs, credentials, policy, and authority should remain
machine state wherever the model does not need to reason about them.

### Instrument the agent loop when the runtime exposes it

Cycle duration, tool latency, tool failure rates, and token/cache metrics are
useful. Forge should record them opportunistically without making them a
prerequisite for runtimes that expose only task-level timing.

### Evaluate prompts offline

Strands Evals is a useful reference for replaying incidents and comparing
reviewer or routing changes. Production settlement remains bound to
deterministic evidence and durable Forge state.

### Attach policy to the action boundary

Before-tool interventions and explicit authorization are stronger than asking
a model to remember a rule. Forge should continue enforcing write, credential,
review, and publication boundaries where the action occurs.

## What Forge Should Not Copy

- API-first execution that gives up existing Claude and ChatGPT subscription
  economics.
- Model-driven swarms as publication or review authority.
- Local-file or S3 session snapshots presented as a complete work ledger.
- In-process tools without an independent OS boundary for builders.
- A virtual shell presented as sufficient isolation for arbitrary project
  builds and tests.
- AWS AgentCore services as a prerequisite for Forge's local operator
  experience.
- Python-only supporting systems where the TypeScript surface cannot meet the
  required contract.

## Verdict

**Strong agent SDK and architectural reference; not a Forge replacement.**

Strands is most compelling when building a new Bedrock-native agent
application. Forge is solving a different problem: safely coordinating
subscription-backed coding agents through durable work, Git isolation,
evidence, review, CI, and publication while giving a human an honest operating
surface.

No replacement pilot is warranted. A future component investigation should be
limited to TypeScript metrics/evaluation interoperability and should not
displace the active Forge plan.

## Primary Evidence

- [Strands Agents overview](https://strandsagents.com/)
- [TypeScript quickstart, credentials, default Bedrock provider, and metrics](https://strandsagents.com/docs/user-guide/quickstart/typescript/)
- [Multi-agent pattern comparison](https://strandsagents.com/docs/user-guide/concepts/multi-agent/multi-agent-patterns/)
- [Workflow pattern](https://strandsagents.com/docs/user-guide/concepts/multi-agent/workflow/)
- [Session management and storage](https://strandsagents.com/docs/user-guide/concepts/agents/session-management/)
- [Anthropic model provider](https://strandsagents.com/docs/user-guide/concepts/model-providers/anthropic/)
- [OpenAI model provider](https://strandsagents.com/docs/user-guide/concepts/model-providers/openai/)
- [Metrics](https://strandsagents.com/docs/user-guide/observability-evaluation/metrics/)
- [Observability](https://strandsagents.com/docs/user-guide/observability-evaluation/observability/)
- [Evals source](https://github.com/strands-agents/evals/tree/0bf12520908fcf02ca39acaf11cd302587988787)
- [Strands Shell architecture and limits](https://strandsagents.com/docs/user-guide/shell/)
- [Versioning and support policy](https://strandsagents.com/docs/user-guide/versioning-and-support/)
- [Apache-2.0 harness source](https://github.com/strands-agents/harness-sdk/tree/526692f53d403522a650a926a9332d7b2272cfaa)
