# Paperclip Assessment Compared To Forge

Date: 2026-09-28.

Paperclip source inspected: [`paperclipai/paperclip`](https://github.com/paperclipai/paperclip),
commit `0f14d261233c545aa6a8a38ec253c498a5130fff` (2026-09-27, 4,603 commits).
Forge source inspected: this repository at `8e8e7e9f` (2026-09-28).

Evidence was gathered by six read-only lanes under FG-814: Paperclip's
control plane and work model (lane A), its runtime and extensibility (lane B),
its data model, run lifecycle and engineering quality (lane C), a Forge
profile on the same axes (lane D), Paperclip's web UI as an operator control
plane (lane E), and a Forge dashboard profile (lane F). Each lane read
source, schema and tests and cited path and line. The synthesis re-checked
the claims that recommendations depend on against both source trees.
Paperclip paths below are relative to the Paperclip repository root; Forge
paths are relative to this repository.

Companion document: [Recommendations For Forge From Paperclip](paperclip-forge-recommendations.md).

## Executive Take

Paperclip is a multi-tenant control plane for running an "AI company". A
company has an org chart of long-lived agents with job titles, managers,
monthly budgets and heartbeat schedules. Humans are members with roles and
permission grants. Work lives on a Linear-like issue board. A Postgres-backed
server wakes agents on timers and events, lets them check out issues, and
records what they did. Around that core sit adapters for about a dozen coding
CLIs, an experimental Rust runner, sandbox-provider plugins, a governed MCP
gateway, a secrets manager, a skills store and chat connectors.

Forge is a single-operator build pipeline. An interactive orchestrator session
routes each request through a compiled RACI table and dispatches ephemeral,
one-task Docker containers. Correctness comes from kernel-enforced mount modes,
adversarial read-only reviewers, a SHA-bound review ledger, and Forge-owned
compare-and-swap publication.

The one-sentence difference: **Paperclip makes agents persistent employees and
trusts organisational process to keep them productive; Forge makes agents
disposable workers and trusts only evidence bound to an exact commit.**

What Forge should learn is operational rather than architectural. Paperclip
has solved the problems Forge admits to: spend has no ceiling, recovery runs
only when someone types a command, and agents cannot ask a question mid-run.
Its budget ledger with admission-time enforcement, its always-on
reconcile-and-reap tick, its typed and resolvable asks, and its typed recovery
records transfer cleanly. The persistent org, the agent-callable control-plane
API, and the claim-based completion model do not.

## What Paperclip Is

**Company.** The tenant boundary. Every domain row carries `company_id`, and
tenant isolation is enforced in application code with no row-level security
(lane C §1.3). Governance switches such as `requireBoardApprovalForNewAgents`
live on the company row (`packages/db/src/schema/companies.ts:4-37`).

**Org chart.** Agents form a tree through a self-referencing `reportsTo`
column and carry a job-title role such as CEO, CTO or QA
(`packages/db/src/schema/agents.ts:16-50`; `packages/shared/src/constants.ts:46-59`).
The tree affects authorization only narrowly (manager scopes, active-checkout
management), but org health gates work: a terminated manager or a reporting
cycle makes an agent uninvokable (`server/src/services/agent-invokability.ts:13-39`;
lane A §1).

**Agents and humans as principals.** Humans and agents share one membership
table and receive per-principal permission grants (21 keys) evaluated by a
single `authorizationService.decide` (`server/src/services/authorization.ts:1420-2296`).
Each agent request is also re-evaluated as the agent's *responsible human* and
denied unless both pass (`authorization.ts:2298-2395`). Lane A found that the
hiring defaults run opposite to the plan: board approval for new agents is off
by default, and non-low-trust agents may create agents
(`packages/db/src/migrations/0071_default_hire_approval_off.sql`;
`server/src/services/agent-permissions.ts:42-49`).

**Tasks (issues).** A company-scoped issue table with seven statuses, a single
assignee (agent or human), a parent tree, `blocks` relations with a cycle check
and run-lock columns (`packages/db/src/schema/issues.ts:25-203`). The
documented transition matrix is not enforced; only a few invariants are
(`server/src/services/issues.ts:302-307,10684-10845`; lane A §2a). An agent
must *check out* an issue with an atomic conditional update bound to its run id
before working on it (`issues.ts:11380-11418`).

**Goals.** A four-level goal tree auto-attached to issues by fallback
(`server/src/services/issue-goal-fallback.ts:3-56`). The wake prompt carries no
goal, and the Goals sidebar is feature-flagged off (`packages/shared/src/feature-catalog.ts:241-247`).
The data exists but the goal-alignment product loop does not (lane A §2c).

**Heartbeats and wakeups.** Agents run in short, bounded *heartbeat runs*.
Every trigger (timer, assignment, comment, mention, approval, dependency done)
becomes an `agent_wakeup_requests` row. The row is admitted, coalesced into a
live run, deferred behind another run's issue lock, or skipped with a recorded
reason (`server/src/services/heartbeat.ts:26170-28340`;
`server/src/modules/wake-queue/domain/policy.ts:45-70`). An in-process 30-second
scheduler drives timers, routines, retries and orphan reaping
(`server/src/index.ts:1626-1775`). Once an agent has two consecutive
successful runs with no issue progress, further wakes cool down exponentially
(`server/src/services/issue-rewake-throttle.ts:3-20`).

**Runs.** `heartbeat_runs` carries status, a per-boot controller lease, process
identity, retry lineage, an event cursor and a liveness classification
(`packages/db/src/schema/heartbeat_runs.ts:23-98`; lane C §2.1). Cancellation
is two-phase and returns 409 if provider termination cannot be verified
(`heartbeat.ts:28947-28962`). Agent writes are serialized against Stop with
`FOR SHARE` on the run row (`server/src/agent-run-cancellation.ts:5-31`).

**Approvals, review stages and plans.** Paperclip has four overlapping
approval mechanisms: board approvals (only `hire_agent` has side effects,
`server/src/services/approvals.ts:144-232`), per-issue execution-policy stages
that route review to a participant who is not the implementer and cap agent
review rounds before escalating to a human
(`server/src/services/issue-execution-policy.ts:484-499,865-891`), typed thread
interactions, and HMAC-signed decision cards. Planning mode stores a revisioned
`plan` document whose approval is bound to a revision (`server/src/services/issue-thread-interactions.ts:2220-2310`).
Quorum is not implemented (`packages/shared/src/validators/issue.ts:386`).

**Budgets.** Company, agent and project spend policies in cents with soft and
hard thresholds. Each cost event is evaluated synchronously. A hard crossing
opens an incident and a `budget_override_required` approval, pauses the scope,
and cancels active and queued work (`server/src/services/budgets.ts:214-260,380-393`).
Subscription-billed usage is recorded as zero cents (`heartbeat.ts:5213`), so
subscription operators get little enforcement beyond daily run caps (lane A §5).

**Routines.** Scheduled, webhook or API triggers that create an ordinary issue
with an origin fingerprint and a declared concurrency policy (coalesce, skip
or always enqueue), backstopped by a partial unique index
(`server/src/services/routines.ts:1712-2050`; `packages/db/src/schema/issues.ts:138-194`).
Lane A calls this area mature: 72 tests in a single service test file.

**Watchdogs and recovery.** An opt-in task watchdog agent reviews a stopped
subtree identified by fingerprint (`server/src/services/task-watchdogs.ts:371-544`).
A silent-run watchdog flags runs that stay quiet for too long. Durable recovery
actions carry an owner type, attempts, an outcome and a one-active-per-issue
constraint (`packages/db/src/schema/issue_recovery_actions.ts:30-63`). Lane A
§6b judges the ROADMAP claim of "enforced outcomes" only partly met. On most
issues, "done" is the agent's own claim (`server/src/services/native-runtime/completion-contracts.ts:38-46`).

**Adapters.** A `ServerAdapterModule` contract with `execute` and
`testEnvironment`. Usage, usage basis (`per_run` or `session_cumulative`),
billing type and a classified `errorFamily` are typed result fields
(`packages/adapter-utils/src/types.ts:69-117,453-545`). There are 16 built-ins.
Claude and Codex are well tested; `process` has no tests (lane B §1).

**Runner.** `paperclip-runnerd`, about 66k lines of Rust. It supervises a
provider harness over an encrypted, replay-safe WebSocket protocol, derives
terminal status from facts it owns rather than the harness's claim, and never
gives the provider a Paperclip credential (`packages/paperclip-runner/README.md:3-15,106-113`).
The feature flag is on by default for self-hosted instances. Agents must still
opt in explicitly, and onboarding stays on legacy adapters
(`packages/shared/src/feature-catalog.ts:53-63`). Runs default to
`runtime_mode = "legacy"` (lane C open question 7).

**Plugins.** Out-of-process Node workers speaking JSON-RPC, with every host
call gated by a manifest-declared capability
(`packages/plugins/sdk/src/host-client-factory.ts:373-400`). There is no OS
sandbox, plugin UI is served same-origin, and SQL filtering is regex-based. The
spec calls plugins trusted code (`doc/plugins/PLUGIN_SPEC.md:11-35`). Sandbox
providers (Daytona, Kubernetes, E2B, Modal and others) are plugins. Only
Daytona runs end to end in CI, and the provider rules are admitted to be
unenforced (`packages/plugins/sandbox-providers/SANDBOX-REQUIREMENTS.md:42-72`).

**Skills.** Per-company skills with full-content versioning in Postgres, a
policy engine, and a static audit of skill bytes with hard stops for
remote-fetch-exec and secret exfiltration. Catalog provenance is sha256-based,
and skills are selected server-side ("caller wake data cannot supply skills",
`heartbeat.ts:21326-21372`; `server/src/services/company-skills.ts:2516-2635`).
Lane B rates this the most mature runtime-side area.

**MCP gateway.** A governed proxy for third-party MCP servers with profiles,
policies, quarantine-on-change, approval-then-auto-execute and per-call audit
(`server/src/services/tool-access-policy.ts:1180-1312`). Each run gets
one-hour tokens revoked in a `finally`, and Claude launches with
`--strict-mcp-config` (`packages/adapters/claude-local/src/server/execute.ts:904`).
The documented "deny always beats allow" does not hold: a higher-priority allow
returns first (lane B §6).

**Secrets.** Versioned company- and user-scoped secrets. A secret resolves only
through a binding row for its consumer and config path, and every resolution
is audited (`server/src/services/secrets.ts:1353-1460`). The soft spots are a
single master key, no AAD, an indexed unsalted hash of the plaintext, and a
binding check that is skipped when no context is passed (lane B §7).

**Channels, CLI and mobile.** A chat-connector subsystem of about 38k lines
turns Slack, Discord, GitHub, Teams, Telegram and email threads into issues.
Questions render as native buttons behind opaque seven-day tokens
(`server/src/services/chat-interaction-publications.ts:1-31`). It is
experimental, off by default, and not production-qualified on any provider
(`doc/plans/chat-adapters/2026-09-06-live-qualification-addendum.md:148`). The
CLI distinguishes `board` and `agent` personas. Mobile is a responsive web UI
with no push notifications (lane B §8).

## Philosophy Contrast

### Persistent org versus ephemeral routed dispatch

Paperclip models agents as employees with identity, a manager, a budget, a
session per task and a heartbeat policy. Agents delegate downward by creating
subtasks and escalate upward through comments and approvals, following a
procedure written into a skill file (`skills/paperclip/SKILL.md:87-157`). Forge
has no standing agents. A role is a prose seed instantiated for exactly one
task, and "who does what" is a compiled route that each dispatch records as a
receipt (`src/v2/task-manifest.ts:11-105`; `seeds/forge-raci.md`).

The motive is visible in Paperclip's own `doc/GOAL.md`: autonomy at company
scale, with humans as a board. Forge's is invariant 15: accountability is
always human. The practical consequence is that Paperclip needs a large
apparatus to keep persistent agents productive and honest (liveness
classification, rewake throttles, stranded-issue recovery, task watchdogs),
while Forge needs almost none of it because a container cannot outlive its
task. Forge instead pays in ergonomics: work stops whenever no human or
orchestrator is driving it.

### Heartbeat-driven autonomy versus orchestrator-session-driven progress

In Paperclip, a server wakes agents on timers or events, and agents pick their
own next issue by following a skill recipe. In Forge, every agent run follows
an explicit act: an operator command, an orchestrator decision, or an armed
dispatcher claiming a queued ticket (invariant 23). Paperclip's model produces
throughput without a human present. It also produces failure modes Forge
cannot have, such as agents re-waking every few seconds on a stalled issue.
Paperclip's throttle module records that a single recovery once paid for 25
sessions at 2.4× cost (`server/src/services/issue-rewake-throttle.ts:3-12`).

### Task board as the UI versus CLI plus dashboard projection

Paperclip's primary surface is a multi-user web app built around the issue
board, an inbox, and a "what needs me" feed ranked by decide-by urgency
(`server/src/services/attention.ts:489-524`). That feed is flagged off by
default. Forge's surface is 60 CLI verbs over one SQLite file, plus a
read-mostly local dashboard that mutates only by shelling out to the CLI
(invariant 10). Paperclip's board *is* execution state. Forge's
competitive synthesis explicitly declines "mutable board columns as canonical
execution state" (`forge-feature-opportunities.md`, decline list).

### Budgets in dollars versus token usage only

Paperclip prices every run and pauses scopes at hard limits. Forge records
per-request tokens and dropped its cost column because "OAuth has no per-token
cost" (`src/store/schema.ts:229-233`). Neither approach handles subscriptions
well. Paperclip zeroes subscription usage and so cannot enforce a budget on it.
Forge enforces nothing at all. Paperclip's evaluation rules state the correct
stance but its budgets do not follow it: "missing cost is unknown, not free"
(`doc/evals.md:109-165`).

### Daemon server versus opportunistic CLI reconcile

Paperclip is a long-running server. It binds HTTP before recovery so native
runners can reattach, reaps orphans at startup and every five minutes, and
refuses to boot on a stale schema (`server/src/index.ts:981-985,1472-1545`;
`server/src/startup-refusals.ts:23-88`). Forge has "no daemon and no resident
observer" (`docs/concepts.md:341`). Reconcile runs at the top of `forge next`,
`forge status` and `forge show --reconcile` (`src/v2/reconcile.ts:1-20`). The
queue dispatcher is a long-lived loop, but it reconciles queue claims, not
orphaned run tasks, and it is not restarted after a reboot
(`src/queue/dispatcher-loop.ts:502-690`; lane D §5). Forge's documented
consequence is a task left `running` for about two hours "because nothing
triggered reconcileRun" (`src/ops/reconcile-candidate.ts:4-8`).

### Adapter breadth versus container runtime depth

Paperclip supports about a dozen CLIs, remote gateways and six cloud sandbox
providers, but its isolation is a driver label. The low-trust preset requires
driver `sandbox`, and provider isolation is not verified
(`server/src/services/low-trust-runtime-containment.ts:44-105`). Forge supports
three runtime kinds (claude-code, codex, pi) on one substrate, local Docker, and
gets enforceable boundaries from it. Kernel `:ro` mounts cover reds, the parent
object store and the dependency environment, and publication authority stays
with Forge (invariants 9, 18). Forge's own weak spots are default Docker
networking, no resource limits, and `NOPASSWD:ALL` sudo in the image
(`docker/agent-dev-worker.Dockerfile:172-174`).

### Approval gates in the product versus an evidence-led review ledger

Paperclip's review is routing. It moves the issue to a participant who is not
the implementer, loops on changes-requested, and escalates to a human after a
round cap. On default issues, completion is the agent's claim that every
auto-derived criterion is met (`completion-contracts.ts:38-46`;
`native-runtime/status-arbiter.ts:272-303`). Forge's review is evidence. Findings are rows
with dispositions and proof bound to a candidate SHA. A skipped test is never
evidence, and a clean ledger with no acceptance mapping still blocks shipping
(`src/v2/review-evidence.ts:208-493`; `src/v2/review-shipping.ts:136-145`).
Paperclip reviews whether someone looked. Forge reviews whether the claim was
demonstrated.

### Plugin edges versus seeds and workflows

Paperclip's ROADMAP line is "thin core, rich edges". Plugins contribute UI
slots, jobs, webhooks, tools, a database schema, sandbox drivers and managed
agents (`packages/shared/src/types/plugin.ts:663-740`). Forge extends by
editing versioned seed files that `forge upgrade` publishes atomically as a
generation and that every dispatch receipts (`src/v2/seed-generation.ts:1-35`).
Paperclip gets an ecosystem and pays for it with trusted-code plugins, an
in-process adapter install over npm, and a capability list that includes
`approvals.respond` despite the spec forbidding it (`constants.ts:1362-1384`).
Forge gets reproducibility and gives up third-party extension.

## Side-By-Side Comparison

| Axis | Paperclip | Forge | Assessment |
|---|---|---|---|
| Deployment shape | Long-running Express server on Postgres (embedded, Docker or hosted) | Host CLI on one SQLite file; no daemon | Different goal |
| Tenancy | Company tenant on every row; application-enforced | Single operator, many projects by `project_key` | Different goal |
| Human roles and permissions | Memberships, 21 grant keys, responsible-user intersection | None; `decided_by` is an unauthenticated confirmation (`docs/SCHEMA-CONTRACT.md:348`) | Paperclip ahead (not wanted) |
| Agent identity | Persistent employee with role, manager, budget, sessions | Stateless role seed per task; sha-stamped protocol | Different goal |
| Routing who does what | Agent picks work by skill recipe; any agent may assign to any active agent | Compiled RACI → routing policy → per-dispatch receipt; enforcement advisory | Forge ahead |
| Unit of work | Issue with loose transitions, single assignee, run lock | Ticket → run → task, CAS state machine, ADR per new status | Forge ahead on rigor |
| Claim semantics | Atomic checkout bound to run id; stale adoption | Fenced queue claims, partial unique index, re-validated under lock | Parity |
| Non-dispatch receipts | Skipped, coalesced and deferred wakes persisted with a reason | `dispatcher_evaluations` with named `ScanReason` per candidate (`src/store/queue-claims.ts:204-226`) | Parity |
| Trigger model | Timers, events, routines, webhooks | Explicit command, orchestrator, or armed dispatcher | Different goal |
| Scheduled work | Routines: cron, webhook, API; concurrency policy; DB dedupe | None | Paperclip ahead |
| Liveness supervision | 30-second in-process tick, 5-minute orphan reaper, startup recovery phase | Opportunistic reconcile; dispatcher not restarted after reboot | Paperclip ahead |
| No-progress control | Exponential rewake throttle after two no-progress runs | None; `launch_failed` makes a ticket immediately re-claimable (`src/queue/dispatch-execution.ts:609`) | Paperclip ahead |
| Crash safety | Controller lease, pid-probe detach vs lost, bounded retry | Detached containers, fenced leases, named crash points, crash-matrix suites | Parity |
| Cancellation | Two-phase, verified termination or 409; write revocation | `forge cancel`; container has no DB write path to revoke | Parity (different mechanism) |
| Recovery records | Typed recovery actions: owner, attempts, outcome, one active per issue | `awaiting_recovery`, five orphan kinds, `forge recover` | Paperclip ahead on shape |
| Mid-run human input | Typed thread interactions with resolver policy and continuation | Gates at step boundaries only | Paperclip ahead |
| Plan approval | Revisioned plan document; approval bound to revision | Campaign `approved_plan_hash`; `raci propose/apply --confirm` | Parity |
| Review routing | Reviewer ≠ implementer; round cap then escalate | Read-only reds; `review-loop` `maxRounds` (`src/v2/review-loop.ts:555`) | Parity |
| Evidence of done | Agent claim on default issues; no work-product requirement | SHA-bound findings, per-test execution parsing, acceptance mapping | Forge ahead |
| Publication | Adapters forbidden to `git push`; no validated publisher found | Candidate built in integration worktree, gated, CAS `update-ref` | Forge ahead |
| Isolation substrate | Driver label; provider isolation unverified; plugins unsandboxed | Kernel `:ro` mounts; private clone for mutators; no network or resource limits | Forge ahead |
| Credentials | Per-human AI connections, token write-back, brokered git | Three auth modes; env allowlist redaction; OAuth volume | Paperclip ahead on breadth |
| Secrets | Binding-row-required resolution, audit per access | Env forwarding with fail-closed allowlist redaction | Paperclip ahead |
| Cost and budget | Cents ledger, soft/hard policies, pause and cancel; subscriptions priced at zero | Token usage per request; no dollars, no ceilings | Paperclip ahead |
| Runtime breadth | ~12 CLI adapters, gateways, 6+ sandbox providers | 3 runtime kinds, 6 runtime seeds, one Docker substrate | Paperclip ahead |
| Model and effort | Per-agent adapter config; runtime model discovery | Capability → profile policy; effort knob mapped per runtime | Parity |
| Extensibility | Capability-gated plugin workers; npm adapter install | Seeds and YAML, atomic generations | Different goal |
| Skills | DB-versioned, policy-governed, byte-audited, hash provenance | Five host skills; one container skill mounted `:ro` | Paperclip ahead |
| Tool governance (MCP) | Gateway, profiles, quarantine, per-run tokens, `--strict-mcp-config` | No MCP config supplied to containers; no strict flag | Paperclip ahead |
| Audit log | `activity_log` with responsible human; writable by board actors via API | Append-only `events`; Forge is the only writer | Forge ahead on integrity |
| Live updates | In-process WebSocket bus, no replay | Dashboard polls durable rows; no outbound calls (invariant 21) | Different goal |
| Operator attention | Inbox (mine/recent/unread/blocked/all) plus a Decisions desk (flagged off by default): both closed-set feeds with inline dismiss/snooze/resolve, audited server-side, resurfacing on new activity, though the two feeds use divergent badge formulas (lane E §2) | Attention Inbox with closed kinds and a `degraded` state, but read-only: resolution is copy-pasting a CLI string, and two of nine kinds (`stale_verification`, `kanban_conflict`) render as an unknown badge (lane F §3, §9) | Paperclip ahead |
| Operator actions from the UI | Approve, pause/resume, cancel, hire/terminate, edit instructions, raise budget, answer asks, with impact preview and typed confirm (lane E §3) | Queue planning + classify only; gates/retry/cancel CLI-only (lane F §2) | Paperclip ahead |
| Remote and mobile | Responsive web; chat connectors experimental | Outbound ntfy/SMS; read/plan remote board | Paperclip ahead (unqualified) |
| Multi-human | Invites, joins, first-admin claim, board keys | Absent by design | Different goal |
| Evals | Scored runner and E2E campaigns, weekly; cases private | Per-change reds and done audit; no longitudinal evals | Paperclip ahead |
| Schema discipline | 284 migrations, SQL safety linter, snapshot-drift test, startup refusal | Additive-only schema, enum-as-convention | Parity (different risks) |
| Test and CI discipline | ~2,071 test files, sharded CI, soak-gated releases, no linter | ~909 test files, tier purity enforced by test | Parity |

## Where Forge Is Ahead

**Evidence-led review with candidate binding.** Nothing in Paperclip
resembles Forge's review ledger. Findings are durable rows with a disposition
kept separate from the resolution proof. `rejected_premise` needs
candidate-bound evidence, and `deferred` needs a ticket
(`src/store/reviews.ts:1724-1862`). Every stage records the SHA it completed
against, and moving the candidate invalidates resolutions (`src/store/reviews.ts:781,2036`).
Evidence strength must match claim strength, and execution is parsed per test
so a skipped test cannot count (`src/v2/review-evidence.ts:43-49,208-493`).
Paperclip's execution-policy stages record *who* approved. They do not record
*what* was proven about *which* artifact.

**Completion is not a claim.** Forge's invariant 11 treats agents as fallible
workers. Paperclip's native runtime generates a completion contract from the
issue title and lets the agent's own claim close low-risk issues. The legacy
path has no work-product requirement at all (lane A §6b). Forge holds an
implementer that reports `complete` without tests or a stated reason at
`awaiting_gate` (`docs/concepts.md:476-493`). Its done audit reads missing
evidence as `unknown`, never `pass` (`src/done-audit/done-audit.ts:111-181`).

**Publication authority and CI evidence reuse.** Forge builds a candidate in a
throwaway integration worktree, gates it, and publishes by CAS. A publisher
that loses its window mutates nothing (invariants 13-14). Host and CI
verification are bound to an exact SHA, and covering evidence must include
every gate member and every CI job green (`src/store/host-verifications.ts:592`).
Paperclip forbids adapters from pushing (`scripts/check-no-git-push.mjs`), but
the lanes found no validated-publication component comparable to Forge's.

**Containment enforced by the kernel.** Reds are `:ro` on the project at the
Docker level (invariant 9). Mutating agents get a private clone with the parent
object store `:ro` (invariant 18). Containers read tickets only from a
read-only snapshot and never reach `forge.db` (invariant 20). Paperclip's
equivalent is a trust preset that requires a sandbox *driver label*. Its
sandbox contract says "This repository does not enforce these provider rules
today", and its plugins run without an OS sandbox (lane B §3-4).

**Routing as a compiled, receipted policy.** RACI SOURCE compiles to a DERIVED
routing policy, and every dispatch records the EFFECTIVE route
(invariants 5-6). The `accountable` field must be `human` (`src/raci/parse.ts:108-111`).
In Paperclip, any standard agent may assign work to any active agent, and
unknown scope keys are ignored (`server/src/services/authorization.ts:457-459,2142-2162`).
Forge's routing is advisory at dispatch, but it is explicit, versioned and
explainable after the fact.

**Research-synthesis and review as workflows.** Forge ships
`research-synthesis` and `security-audit` workflows and evidence-led feature
review with six specialist reds (`seeds/workflows/feature.yml:133-184`).
Paperclip's review stages are single-participant (`approvalsNeeded: z.literal(1)`,
`packages/shared/src/validators/issue.ts:386`) and have no adversarial,
read-only reviewer concept.

**Audit integrity.** Forge is the only writer of its event log. Paperclip's
`POST /companies/:companyId/activity` lets any non-viewer board actor insert
rows with a caller-chosen `actorType` of `agent`, so its audit log is not
tamper-evident (`server/src/routes/activity.ts:92-100,329-339`; verified by
lane A).

**Test tiering and scale discipline.** Forge enforces tier membership and
unit-tier purity with a test (`src/test-tiers.test.ts:1-40`) and names
regression suites after the ticket they guard. Paperclip has more tests in
absolute terms but concentrates run control in one 29,762-line file and runs
no linter (lane C §5).

**Honest status vocabularies.** Forge's surfaces distinguish unknown and
degraded from failed (Attention Inbox `degraded`, the current-activity honesty
rule). Paperclip's attention feed finds exhausted retries by matching the log
string `LIKE 'Bounded retry exhausted%'` (`server/src/services/attention-exhausted-runs.ts:14-18`).
Its liveness classifier partly runs regular expressions over model prose
(`server/src/services/run-liveness.ts:62-77`).

## Where Paperclip Is Ahead

**Spend control.** Paperclip has a complete ledger → policy → incident →
approval → pause chain, enforced at wake admission, queued-run claim,
continuation and recovery (`server/src/services/budgets.ts:718-864`). Forge
has no ceiling of any kind, and has called budgets "future" since May 2026
(`docs/how-to-model-policy.md:547-551`).

**Always-on liveness.** Startup recovery, a periodic orphan reaper that probes
pids to tell detached processes from lost ones, controller leases on every run,
and a startup refusal on schema drift (lane C §2.4). Forge's crash
*correctness* is at least as strong. Its crash *detection* waits for a human.

**Loop damping.** The rewake throttle and the bounded liveness continuations
(at most two, then a comment asking for human help,
`server/src/services/recovery/run-liveness-continuations.ts:9-145`) stop a
persistent system from spending tokens without making progress. Forge's
dispatcher has capacity limits but no failure-history cooldown.

**Typed mid-run asks.** Thread interactions let an agent ask a structured
question, request confirmation or suggest subtasks. Each ask has a resolver
policy (anyone, not the creator, or human only), idempotency, and a declared
continuation that wakes the assignee on accept (`packages/db/src/schema/issue_thread_interactions.ts:16-80`).
In Forge, an agent that needs input can only fail and describe what it needs.

**Operator surface.** Paperclip's UI treats confirmation as a function of
blast radius, not a uniform click: a server-computed impact preview
("N tasks will be cancelled") renders before a destructive fan-out commits,
typed identifier confirmation is reserved for the one irreversible bulk
cancel, and named, inline-resolvable buttons put the verb on the button
itself (lane E §3, items 4-6). A dismiss holds only while the underlying
item's activity has not advanced past it, so resolving attention never
hides new evidence (lane E item 2). Forge's dashboard has none of this: two
POST routes, no gate/retry/cancel surface, and an Attention Inbox whose only
resolution path is copying a CLI string out of `requestedAction` (lane F
§2-3).

**Typed recovery records.** A recovery action carries an owner type, attempt
budget, outcome vocabulary, and at most one active record per issue. A new
failure identity cancels and replaces the old action
(`server/src/services/issue-recovery-actions.ts:243-302`). Forge's
`awaiting_recovery` and orphan kinds describe *what* failed. They record no
owner, attempt count or outcome for the recovery itself.

**Scheduled and external triggers.** Routines are mature: optimistic trigger
claims, bounded catch-up, idempotency, signed webhooks with replay windows, and
dedupe through a DB constraint (lane A §6a).

**Tool and secret governance.** Per-run, short-lived gateway tokens are revoked
in `finally`, and `--strict-mcp-config` stops a checked-in configuration from
adding MCP servers. Secrets resolve only through a binding row, and each
resolution writes an audit row (lane B §6-7). Forge gives containers no MCP
configuration, but it does not pass the strict flag either (no match for
`strict-mcp-config` in `src/` or `seeds/`).

**Usage semantics.** Adapters return usage basis, billing type, cost status
(`reported` or `unpriced`) and a classified error family as typed fields
(`packages/adapter-utils/src/types.ts:69-117`). Forge parses logs into token
rows. It discards the `total_cost_usd` that Claude reports and has no error
taxonomy for provider failures (`src/store/model-calls.ts:222-232`).

**Skills supply chain.** Content-hash provenance, a local-modification hold on
updates, trust level derived from contents, and a pre-install static audit
(lane B §5).

**Longitudinal evals.** A scenario × candidate matrix with hard gates followed
by weighted dimensions, plus explicit hygiene rules: never merge partial
campaigns, and presentation is not the source of truth (lane B §9). Forge
evaluates each change, not models or policies over time.

**Breadth and reach.** More runtimes, remote execution, multi-human access,
and chat-based answering. Paperclip itself qualifies each of these as partial
or experimental.

## Maturity And Risk Read On Paperclip

**Velocity.** 4,603 commits since 2026-02-16, including 675 in the 30 days to
2026-09-27 and about 19 per day over the last quarter. About 2.2M lines of
TypeScript and 66k of Rust. 224 authors all-time, but three people account for
about 80% of commits and one for 62%. 64% of commits carry a co-author
trailer, and 1,995 are co-authored by Paperclip itself (lane C §5, verified
with git). The product is built largely by its own agents at very high speed.

**Contributor model.** A mandatory PR template, including a "Model Used"
field, 21 unit-tested PR gate scripts run under `pull_request_target`, a
stable aggregate required check, SHA-pinned actions, and soak-gated stable
releases that need a written justification to bypass (lane C §5). This is
strong process for an eight-month-old codebase. The untrusted-PR review is a
manual runbook, and no ESLint, Biome or Prettier gate exists despite
`CONTRIBUTING.md:113`.

**File-size and migration signals.** Hotspots include `chat-channels.ts`
(38,464 lines), `heartbeat.ts` (29,762), `tool-access.ts` (20,451) and
`routes/issues.ts` (18,805). There are 214 tables and 284 numbered migrations,
54 of them in the last 30 days. Status columns are plain `text` with no
`pgEnum`. Lane C found a concrete out-of-domain write: a `timed_out` run status
written into a wakeup-status column whose domain excludes it
(`heartbeat.ts:24981-24983`). Migration tooling is careful, with a SQL safety
linter, snapshot-drift test, custom journal reconciliation and startup refusal.
The schema itself is churning fast.

**Single-process assumptions.** The per-agent start lock is an in-process
`Map` (`server/src/services/agent-start-lock.ts:1-48`). The live-event bus is
an in-process `EventEmitter`. The board-claim token lives in memory. The
per-run claim is safe across processes, but the per-agent concurrency cap is
not, so horizontal scale-out would need rework (lane C §2.2).

**Doc/code drift.** Drift is pervasive and usually runs in one direction: the
docs promise more than the code does.

- `doc/TASKS.md` describes a different, Linear-style model.
- Docs still describe PGlite, but the code runs real Postgres.
- The approval-reject wake is documented but does not happen.
- MCP governance is documented as "deny beats allow", which the code does not do.
- The plugin spec forbids approval capabilities that the code ships.
- The task watchdog does less than its doc (lane A §6b; lane B §4, §6; lane C §1.1).

The ROADMAP ✅ marks are accurate on breadth and overstated on proof. Sandboxes
are real, but only Daytona is exercised end to end. "Enforced outcomes" covers
liveness and routing, not artifacts. The agent-evals cases live in a private
repository.

**Solid.** The following look solid:

- the checkout and claim path
- wakeup admission, coalescing and deferral
- run recovery and cancellation
- routines
- budgets as a mechanism
- skills
- the authorization engine
- migrations
- release engineering

Each has large, specific test suites.

**Likely to churn.** The following look likely to churn:

- the four overlapping approval mechanisms, and the three notions of "changes requested"
- goals, which are flag-gated and not injected into prompts
- the attention feed, which is flag-gated off
- the native runner, whose semantic catalog has 35 operations with 25 implemented
  (`server/src/services/native-runtime/paperclip-runner-tool-authority.ts:81-88`)
- chat connectors, which are unqualified
- plugin UI isolation (Phase 2)
- GCP and Vault secret providers, which are stubs

**Implemented, experimental, roadmap.**

- **Implemented:** multi-human access, the activity log, self-healing runs,
  routines, budgets, skills and company import/export.
- **Experimental:** the native runner, most sandbox providers, chat connectors,
  CEO chat and the plugin runtime.
- **Roadmap only:** work queues, beyond some `pipelines` and `cases` tables.

## Doc/Code Drift Found In Forge During This Study

Lane D found these, and the synthesis re-checked the first two. Each is small
enough to ticket directly.

- `docs/repo-guide.md:69` says agent sudo is "scoped to the node_modules
  shadow-volume chown". The image grants `agent ALL=(ALL) NOPASSWD:ALL`
  (`docker/agent-dev-worker.Dockerfile:172-174`), and `src/v2/spawn.ts:149`
  says so correctly.
- `src/queue/dispatch-execution.ts:609,658` document that a `launch_failed`
  release leaves the ticket immediately re-claimable. That is a behaviour, not
  drift, but it is not mentioned in `docs/concepts.md`'s dispatcher section.
- `src/v2/startRun.ts:8-9` says "NOT YET WIRED TO CLI". It is called from
  `src/cli/commands/new.ts:162`.
- `src/cli/commands/continue.ts:58`: the help example uses
  `nextAction.kind:"invoke"`, which the code rejects (`:203-209`).
- `docs/how-to-new-agent.md:81` says `activity` is "resolved by LiteLLM". It
  also calls a new red "config-only", but a new red needs a
  `DEFAULT_ACTIVITY_BY_ROLE` entry (`src/v2/model-resolution.ts:97-120`).
- `docs/how-to-use-forge-across-projects.md:45,95` still say `.forge/` holds
  only workflow overrides.
- `dashboard/src/server.ts:24` says "four POSTs… the ONLY mutating routes".
  Classify is a fifth (`:112`).
- `docs/concepts.md:178` calls queue claims "primitives only". The dispatcher
  has shipped.
- `src/store/schema.ts:669-671` says "Nothing reads this… in Slice A". This is
  contradicted by `src/backlog/storage-mode.ts:20`.
- `container.remove_on_exit` is declared in `src/v2/schema.ts:397` but never
  read.
- `backlog/PLAN.md` still frames v0.1.0 as the goal. The tag has existed since
  2026-08-20 (`a7c209ca`).

## Sources Inspected

Lane reports (FG-814, read-only):

- Lane A: Paperclip control plane and work model.
- Lane B: Paperclip runtime and extensibility.
- Lane C: Paperclip data model, run lifecycle, observability, API and
  engineering quality.
- Lane D: Forge profile on the same axes.
- Lane E: Paperclip's web UI as an operator control plane.
- Lane F: Forge dashboard profile.

Paperclip (commit `0f14d2612`), principal paths:

- **Schema:** `packages/db/src/schema/` (`companies.ts`, `agents.ts`,
  `issues.ts`, `heartbeat_runs.ts`, `agent_wakeup_requests.ts`,
  `budget_policies.ts`, `issue_recovery_actions.ts`,
  `issue_thread_interactions.ts`, `routines.ts`, `tool_access.ts`)
- **Constants and flags:** `packages/shared/src/constants.ts`,
  `packages/shared/src/feature-catalog.ts`
- **Services:** `server/src/services/` (`heartbeat.ts`, `issues.ts`,
  `authorization.ts`, `budgets.ts`, `costs.ts`, `routines.ts`,
  `task-watchdogs.ts`, `issue-rewake-throttle.ts`,
  `issue-execution-policy.ts`, `issue-thread-interactions.ts`, `attention.ts`,
  `tool-access-policy.ts`, `secrets.ts`, `company-skills.ts`,
  `native-runtime/`, `recovery/`)
- **Server entry points:** `server/src/index.ts`, `server/src/shutdown.ts`,
  `server/src/middleware/auth.ts`, `server/src/routes/`
- **Adapters and runner:** `packages/adapter-utils/src/types.ts`,
  `packages/adapters/*`, `packages/paperclip-runner/`
- **Plugins:** `packages/plugins/`
- **Repository docs:** `ROADMAP.md`, `AGENTS.md`, `doc/`, `docs/`
- **CI and tests:** `.github/workflows/`, `tests/`

Forge (commit `8e8e7e9f`), principal paths:

- **Contracts and docs:** `docs/invariants.md`, `docs/concepts.md`,
  `docs/SCHEMA-CONTRACT.md`, `docs/repo-guide.md`
- **Store:** `src/store/schema.ts`, `src/store/tasks.ts`,
  `src/store/reviews.ts`, `src/store/model-calls.ts`,
  `src/store/queue-claims.ts`, `src/store/host-verifications.ts`
- **Dispatch and execution:** `src/v2/runNext.ts`, `src/v2/spawn.ts`,
  `src/v2/compose.ts`, `src/v2/model-resolution.ts`, `src/v2/reconcile.ts`
- **Review:** `src/v2/review-evidence.ts`, `src/v2/review-gate.ts`,
  `src/v2/review-shipping.ts`, `src/v2/review-loop.ts`
- **Queue:** `src/queue/dispatcher-loop.ts`, `src/queue/dispatch-execution.ts`
- **Routing:** `src/raci/`
- **Seeds and image:** `seeds/`,
  `docker/agent-dev-worker.Dockerfile`
- **Dashboard:** `dashboard/src/`
- **Prior research:** `docs/research/competitive/forge-feature-opportunities.md`
