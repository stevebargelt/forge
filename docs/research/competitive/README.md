# Competitive Analysis

This is the concise synthesis of Forge competitive research. Use it to find
the strongest ideas and the detailed assessment behind each one. The linked
assessments contain the evidence, qualifications, and recommendations; the
original sources are linked separately.

## Best Ideas For Forge

### Make work visibly traceable

The strongest shared product idea is a navigable chain from intent to result:

**backlog item → run/session → tasks and agents → files and diffs → review
evidence → commit/PR**

Nimbalyst demonstrates the richest typed provenance. GasTown demonstrates
durable work identity and visible orchestration objects. Forge already has
most of the canonical IDs and evidence; it needs a better operator projection
of their relationships.

### Route attention, not activity

The operator should primarily see what needs a decision, what is anomalous,
what recovered automatically, and what is ready for review. Nimbalyst's mobile
supervision, Agent Deck's attention inbox, GasTown's convoy view, and Claude
Deck's honest reachability states all reinforce this direction.

### Keep authority separate from projections

Dashboards, terminal UIs, mobile clients, semantic indexes, and third-party
tools should consume Forge state without becoming its authority. Forge's
database, gates, claims, receipts, and publication state remain canonical.
External surfaces should default to read-only and advertise their actual
capabilities.

### Support flexible playbooks and enforced workflows

Nimbalyst shows how cheaply prompt-driven workflows can be changed. The Vjeko
workflow shows why focused, adversarial reviewer roles are valuable. Forge
should eventually support versioned, agent-interpreted playbooks for rapid
experimentation while reserving enforced workflows for unattended and
correctness-bearing execution. A successful playbook can graduate into an
enforced workflow.

### Treat work identity as more durable than a process

GasTown and Agent Deck both separate work or agent identity from an individual
terminal process. Forge should keep backlog items, runs, tasks, launches,
attempts, and evidence durable across process and session restarts.

### Preview consequential actions

Claude Deck's plan-hash pattern is a strong operator contract: show the exact
launch plan, bind approval to that plan, and require renewed approval if it
changes. The same idea applies to campaigns, routing changes, and other
high-impact Forge actions.

### Use specialized adversarial reviewers

Reviewers are more useful when each has a narrow failure hypothesis and
checklist: specification fidelity, test validity, coverage, security, or a
named trust boundary. Several correlated model opinions are not independent
proof, so Forge should record reviewer purpose, inputs, artifact identity, and
evidence rather than count gates.

### Make capacity and backpressure visible

GasTown's scheduler and Agent Deck's group concurrency queues validate explicit
capacity limits and visible waiting. Forge's queue should combine operator
stack rank with current capacity and safe parallelism rather than treating
every eligible item as immediately runnable.

### Keep semantic retrieval derived and attributable

Pinecone could help retrieve related decisions, incidents, tickets, and prior
solutions across projects. Original documents, Git, and Forge records must
remain authoritative. Retrieved context should name its source, revision,
generation, and model, and its absence must not break orchestration.

## Provider And Authentication Compatibility

Subscription sign-in and API-key billing are different authentication modes.
In particular, Nimbalyst's OpenAI API-key option is not evidence of subscription
support; its Codex subscription support comes from ChatGPT OAuth.

| Product | Claude Pro/Max subscription | Codex via ChatGPT subscription | Claude via Amazon Bedrock | Important caveat |
|---|---|---|---|---|
| Nimbalyst | Yes — Claude Code subscription sign-in | Yes — ChatGPT OAuth | Yes, with caveats | OpenAI API-key sign-in is a separate, usage-billed alternative. Bedrock has documented MCP and tool-search compatibility limitations. |
| GasTown / GasCity | Yes — launches the authenticated Claude CLI | Yes — launches the authenticated Codex CLI | Yes — forwards AWS and Bedrock environment variables | Authentication belongs to the underlying CLI; GasTown does not turn API billing into subscription access. |
| Agent Deck | Yes — uses authenticated host sessions and Claude profiles | Yes — uses authenticated host sessions and can share Codex auth with its sandbox | Yes on the host; limited in the Docker sandbox | The sandbox rejects a home-relative `.aws` mount, so AWS-profile or SSO-based Bedrock does not work there by default. |

Primary evidence: [Codex authentication modes](https://learn.chatgpt.com/docs/auth)
and [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started);
Nimbalyst on [Claude subscriptions](https://github.com/Nimbalyst/nimbalyst/blob/b4ed503e0252a88bfe4ba4b91545f7a7bcb3d7a8/CHANGELOG.md#L780),
[Codex subscription sign-in](https://github.com/Nimbalyst/nimbalyst/blob/b4ed503e0252a88bfe4ba4b91545f7a7bcb3d7a8/CHANGELOG.md#L93),
and [Bedrock detection](https://github.com/Nimbalyst/nimbalyst/blob/b4ed503e0252a88bfe4ba4b91545f7a7bcb3d7a8/packages/electron/src/main/services/ai/aiServiceUtils.ts#L174-L180);
GasTown on [runtime configuration](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/README.md#L454-L481)
and [Bedrock environment forwarding](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/config/env.go#L359-L368);
Agent Deck on [profiles and environment files](https://github.com/asheshgoplani/agent-deck/blob/d639ae83b7a40a761666a74f006f3c428cf6998b/README.md#L185-L220),
[sandbox authentication sharing](https://github.com/asheshgoplani/agent-deck/blob/d639ae83b7a40a761666a74f006f3c428cf6998b/README.md#L409-L424),
and the [AWS credential-mount limitation](https://github.com/asheshgoplani/agent-deck/blob/d639ae83b7a40a761666a74f006f3c428cf6998b/skills/agent-deck/references/sandbox.md#L194-L205).

## Analysis Index

| Subject | Best idea to retain | Forge assessment | Original source |
|---|---|---|---|
| Nimbalyst | Typed provenance, artifact-centered context, attention routing, and a cheaper playbook layer | [Assessment](nimbalyst-forge-assessment.md) | [Product](https://nimbalyst.com/) · [Source](https://github.com/Nimbalyst/nimbalyst) |
| Vjeko agent workflow | Narrow adversarial reviewers and falsifiable red/green evidence | [Assessment](vjeko-agent-workflow-forge-assessment.md) | [Article](https://vjeko.com/2026/07/21/i-dont-trust-my-agents-either/) |
| Agent Deck | Project-first session navigation, durable attention inbox, visible concurrency, and recovery UX | [Deep assessment](agent-deck-forge-assessment.md) | [Source](https://github.com/asheshgoplani/agent-deck) |
| AgentDeck and agent-deck | Hooks-first observation, capability-aware adapters, and strict monitor/controller separation | [Comparative assessment](agentdeck-forge-assessment.md) | [AgentDeck](https://github.com/puritysb/AgentDeck) · [agent-deck](https://github.com/asheshgoplani/agent-deck) |
| Claude Deck | Plan hashes, team presets, honest reachability, and safe configuration changes | [Assessment](claude-deck-forge-assessment.md) | [Product](https://claudedeck.org/) · [Source](https://github.com/adrirubio/claude-deck) |
| GasTown / GasCity | Private worker commits separated from deterministic publication authority, plus durable work, capacity scheduling, and human-scale progress objects | [Assessment](gastown-forge-assessment.md) | [GasTown](https://github.com/gastownhall/gastown) · [Gas City](https://github.com/gastownhall/gascity) |
| Pinecone | Attributed cross-project semantic retrieval as a rebuildable, non-authoritative plane | [Assessment](pinecone-forge-assessment.md) | [Database](https://docs.pinecone.io/guides/get-started/overview) · [Nexus](https://www.pinecone.io/blog/pinecone-nexus-public-preview/) |
| Open agentic workflow landscape | Free, open-source, non-Python shortlist with a common failure scenario and explicit eliminations | [Landscape snapshot](agentic-workflow-landscape.md) | [Primary sources](agentic-workflow-landscape.md#primary-sources) |
| Forge feature opportunities | Prioritized features to borrow, existing backlog coverage, minimal slices, and explicit non-goals | [Feature pass](forge-feature-opportunities.md) | Synthesis of the pinned assessments in this index |
| Stoneforge | Same-worktree crash recovery and detached publication, with correctness gaps made explicit | [Assessment](stoneforge-forge-assessment.md) | [Source](https://github.com/stoneforge-ai/stoneforge) |
| Agent Orchestrator | Generation-fenced lifecycle observations, preservation refs, and daemon reconciliation | [Assessment](agent-orchestrator-forge-assessment.md) | [Source](https://github.com/AgentWrapper/agent-orchestrator) |
| Maestro | One canonical workflow source generated across agent runtimes, plus an Express/Standard split | [Assessment](maestro-forge-assessment.md) | [Source](https://github.com/josstei/maestro-orchestrate) |
| Claude Squad | Worktree-per-session as a compact default, plus a warning about shared host tmux ownership | [Assessment](claude-squad-forge-assessment.md) | [Source](https://github.com/smtg-ai/claude-squad) |

## Standing Boundary

Competitive research is evidence, not an automatic backlog generator. New
ideas should first strengthen the current product direction or enter the
mutable plan. They should not become foundational prerequisites merely
because another product implements them.

When adding an assessment:

1. Add it to the index with one concise idea worth retaining.
2. Promote a new cross-product lesson above only when it changes or sharpens
   Forge's direction.
3. Link both the detailed Forge assessment and the original source.
4. Keep implementation scope and binding decisions in the backlog, plan, or
   ADR rather than in this research index.
