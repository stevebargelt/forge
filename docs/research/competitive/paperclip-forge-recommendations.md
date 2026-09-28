# Recommendations For Forge From Paperclip

Date: 2026-09-28. Source commits: Paperclip `0f14d2612` (2026-09-27), Forge
`8e8e7e9f`. Evidence: the FG-814 lane reports and the companion
[Paperclip Assessment Compared To Forge](paperclip-forge-assessment.md).
Paperclip paths are relative to the Paperclip repository root; Forge paths are
relative to this repository.

## Summary

Paperclip's value to Forge is concentrated in the machinery that keeps a
long-running agent system solvent and moving: a spend ledger evaluated at
admission time, an always-on reconcile tick, damping for loops that make no
progress, typed human asks with a declared continuation, and typed recovery
records. Forge lacks each of these. `docs/research/competitive/forge-feature-opportunities.md`
does not cover any of them except recovery, which it treats as a gap audit
rather than a record shape. None of them requires Forge to adopt Paperclip's
persistent org, its agent-callable control-plane API, or its claim-based
completion. The three P1 items close admitted Forge weaknesses: no spend
ceiling, crash detection that waits for a human, and usage data too thin to
price. They fit inside invariants 1, 10, 11 and 23 as long as budgets remain
admission tests and never become reapers. Everything else is P2 or P3 and
should follow the existing backlog discipline: gap-walk first, then file.

| # | Recommendation | Priority | Size |
|---|---|---|---|
| 1 | Supervised controller loop: reconcile sweep, continuation drain, milestone notify | P1 | Medium-Large |
| 2 | Typed usage semantics: cost status, usage basis, provider error family | P1 | Small |
| 3 | Spend guardrails as admission tests | P1 | Medium |
| 4 | Status-domain guard for enum-as-convention columns | P2 | Small |
| 5 | Lock the container MCP surface with `--strict-mcp-config` | P2 | Small |
| 6 | Failure-history cooldown in the queue scan | P2 | Small |
| 7 | Bounded automatic retry for infrastructure-classified failures | P2 | Small-Medium |
| 8 | Refuse contradictory auth routing at spawn (`auth_routing_incompatible`) | P2 | Small |
| 9 | Typed operator asks with a declared continuation | P2 | Medium |
| 10 | Typed recovery records with owner, attempts and outcome | P2 | Medium |
| 11 | One outbound safe-projection function for notifications | P3 | Small |
| 12 | Content-hash provenance and a static audit for skills and role seeds | P3 | Small |
| 13 | Role-scoped secret bindings | P3 | Medium |
| 14 | Scheduled triggers that file and enqueue, never dispatch | P3 | Medium |
| 15 | Answer operator asks from a phone with opaque expiring tokens | P3 | Medium |
| 16 | Policy evals: scenario × profile matrix with hard gates | P3 | Large |

## P1 — Must

### 1. Supervised controller loop: reconcile sweep, continuation drain, milestone notify

**Pattern.** Paperclip's server drives recovery from a single scheduler.

- It binds HTTP before recovery so detached runners can reattach.
- It runs a recovery phase at startup: hot-restart adoption, orphan reaping,
  retry promotion and stranded-issue reconciliation (`server/src/index.ts:981-985,1472-1545`).
- It repeats the orphan reaper every five minutes (`index.ts:1759-1790`).

The reaper skips runs that another owner provably holds. For the rest, it
probes the OS pid and classifies each run as `process_detached` (alive,
keep running) or `failed/process_lost` (dead). A dead run gets its leases
released, a lifecycle event appended, and at most one retry
(`heartbeat.ts:18841-19330`).

**Why it fits Forge.** This is Forge's most clearly admitted liveness gap.
Reconcile is opportunistic. It runs at the top of `forge next`, `forge status`
and `forge show --reconcile` (`src/v2/reconcile.ts:1-20`), and "there is no
daemon and no resident observer" (`docs/concepts.md:341`). The recorded
failure is a task left `running` for about two hours "because nothing
triggered reconcileRun" (`src/ops/reconcile-candidate.ts:4-8`).

Forge already has a long-lived process. The queue dispatcher wakes on durable
rows and runs a five-minute watchdog tick (`src/queue/dispatcher-loop.ts:11-33,122-133`).
That tick reconciles queue *claims* (`reconcileClaimExecution`, `:568`), not
run *tasks*: `reconcileRun` is called only from CLI commands and `src/ops/`.
The dispatcher is also not restarted after a reboot (D9;
`learnings/decisions/2026-08-06_queue-dispatch-capacity-and-authorization.md:95,148`).

Separately, an orchestrator session's own continuation state is durable
(`src/store/continuations.ts`): a continuation reaches `ready` the moment its
awaited launch is observed terminal, and the row already carries the
persisted `next_action` for the transition (`src/cli/commands/continue.ts`).
Advancing a `ready` continuation is a lookup and a claim, not a judgment call.

**Why this matters on Bedrock hosts.** The orchestrator seed admits that
`Monitor` and `ScheduleWakeup` — the completion-driven wake path — are
**not available on Amazon Bedrock / Claude-on-AWS / Google Cloud Agent
Platform / Microsoft Foundry**, and that those hosts fall back to a
fixed-cadence `/loop` or an operator re-prompt to resume a wait
(`seeds/orchestrator-template.md:467-472`). Today that means a Bedrock-hosted
orchestrator session holds a long blocking wait, or sits idle between `/loop`
ticks, purely because nothing else advances its continuations. A controller
loop changes that: mechanical transitions — a launch reaching terminal state,
its persisted next action dispatching — advance with no session attached at
all, and the orchestrator session only needs to drain whatever the loop
already advanced on its next tick or `/loop` firing. The loop does not replace
`Monitor`/`ScheduleWakeup` where they exist; it is what makes their absence on
Bedrock/Vertex/Foundry survivable.

**Proposed shape.** Add a reconcile sweep, a continuation drain, and a
milestone notify to one supervised process.

1. Add a `forge reconcile watch` loop. It calls the existing `reconcileRun`
   for every `active` run on the host at a bounded interval, and writes one
   evaluation row per sweep: runs examined, orphans classified, and actions
   taken. The row mirrors `dispatcher_evaluations`, so an idle sweep is still
   evidence.
2. On the same tick, list every continuation in state `ready`
   (`listContinuations({state: 'ready'})`) and run `forge continue
   --continuation-id … --source-launch … --phase … --next-action …` for each,
   using the row's own persisted phase and next action. This is exactly the
   command the orchestrator session would otherwise have issued; the loop
   supplies no new judgment, only the mechanical claim-and-dispatch.
3. On a continuation's terminal advance, emit `forge notify milestone --run
   <id> --kind batch_complete` (or the applicable kind) so the operator learns
   the work moved without a session having to hold the wait open.
4. Let the dispatcher tick call the same sweep when it is armed, so hosts
   running the dispatcher need no second process.
5. Close D9 by shipping an optional launchd agent template for the watch loop.
   Forge's orchestrator host is macOS-only for isolation. `forge doctor`
   reports whether the watch loop is supervised.

The sweep uses only reconcile's and continuation-consumption's existing
actions. It never dispatches new work on its own authority, so it needs no
arming, and it does not touch invariant 23's authorization rule. Size:
medium-large. Touches `src/v2/reconcile.ts` callers, a new CLI verb, a new
evaluation table, `forge doctor`, a launchd template under `scripts/`, and the
continuation drain over `src/store/continuations.ts` / `src/cli/commands/continue.ts`
plus `src/cli/commands/notify.ts`.

**Risks and what not to copy.** Paperclip's reaper queues a bounded automatic
retry; Forge's retry policy already classifies which failure kinds are safe to
re-dispatch, and only the executor is manual today. The controller loop is the
natural executor for the bounded automatic retry in recommendation 7 (the new
entry below). The sweep may classify, record and surface in the Attention
Inbox, but re-driving stays `forge recover --re-drive`. Keep
reconcile's assumption that a container with unknown liveness is alive
(`src/v2/reconcile.ts:1-20`); Paperclip's pid-probe split between detached
and lost is the same stance. Do not build a general daemon that owns
lifecycle. The loop is a supervised caller of existing verbs, and its
authority is strictly mechanical: it advances a `ready` continuation exactly
as its persisted next action says, and reconciles a run exactly as
`reconcileRun` already would. Any judgment-bearing step — reading a result,
deciding a gate — still parks for the orchestrator; the loop drains the
mechanical backlog so the orchestrator's next tick has less of it to do, it
never makes the call itself.

**Priority.** P1.

### 2. Typed usage semantics: cost status, usage basis, provider error family

**Pattern.** Paperclip adapters return usage as typed result fields rather
than leaving the server to infer them from logs (`packages/adapter-utils/src/types.ts:69-117`):

- `usageBasis` says whether a report is a per-run delta or a cumulative
  session total.
- `billingType` distinguishes metered API, subscription-included and
  subscription-overage usage.
- `costUsd` is carried where the provider reports it.
- A classified `errorFamily` (`transient_upstream`, `provider_quota`,
  `model_refusal`, …) accompanies failures.

The server subtracts previous totals for cumulative adapters
(`server/src/services/heartbeat.ts:11953-11981`) and marks usage without a
price as `unpriced` rather than zero (`heartbeat.ts:5218-5229`). Its eval
discipline states the rule plainly: "missing cost is unknown, not free"
(`doc/evals.md:109-165`). Paperclip breaks that rule in its own budget path by
forcing subscription usage to zero cents (`heartbeat.ts:5213`). Forge should
not copy that part. Its own `resolveClaudeBillingType` is the precedent worth
copying instead: it stamps a Claude run's billing type from the env the
adapter actually launched with — Bedrock env maps to `metered_api`, an API key
to `api`, anything else to `subscription`
(`packages/adapters/claude-local/src/server/execute.ts:157-166`).

**Why it fits Forge.** `model_calls` is token-only
(`src/store/schema.ts:229-244`). The Claude stream-json `total_cost_usd` and
pi's pre-computed cost are dropped (`src/store/model-calls.ts:222-232`).
`forge usage` can offer only a unitless `weighted_tokens` proxy
(`src/cli/commands/usage.ts:1-18`). Recommendation 3 cannot price anything
without this. A failure taxonomy would also let the retry policy, the
attention inbox and the dispatcher distinguish a quota wall from a model
refusal without parsing log text.

**Proposed shape.** Add these nullable columns to `model_calls` through
`ADDITIVE_COLUMNS`:

- `cost_usd_reported`
- `cost_usd_estimated` (nullable)
- `cost_status` (`reported | derived | unpriced`)
- `billing_mode` (`metered | subscription | unknown`)

`billing_mode` is a rule, not a parsed detail: it is stamped at dispatch from
the runtime seed's own `auth_strategy` — `aws-bedrock` → `metered`,
`oauth-volume` → `subscription`, an API-key auth strategy → `metered`,
anything else → `unknown` — never inferred from container env at parse time.
Forge already declares the abstract category on the seed itself
(`auth_strategy: aws-bedrock`, `seeds/runtimes/claude-bedrock.yml:21`;
`auth_strategy: oauth-volume`, `seeds/runtimes/claude-oauth.yml:21`), so
stamping `billing_mode` from `runtimeMeta.authStrategy` at the same point
`runContainer` already resolves it (`src/v2/runNext.ts:5022`) is a lookup, not
an inference, and it keeps the vocabulary closed to the three values above.

`cost_usd_estimated` is informational only, never a spend figure. On a
`subscription` run it holds the would-have-cost at API list rates: Claude
Code's own `total_cost_usd` on OAuth already reports that estimate, and where
a runtime's CLI does not, it is derived from a price table applied to the
call's tokens. On a `metered` run it stays null, because `cost_usd_reported`
(or a `derived` `cost_status`) already holds the real figure. It is never
summed into spend and never evaluated by a budget policy; `forge usage`
renders it in its own labeled column ("est. at API rates") so an operator can
answer "what would this month have cost on the API" for subscription rigs
without pretending it was spent.

Each `log_format` parser fills `cost_usd_reported` / `cost_status` where the
runtime reports cost. Add a `provider_failure_family` field to the task's
failure evidence, populated from the same parsers, and keep its vocabulary
closed in TypeScript, as FG-585 requires for enum-as-convention columns.
`forge usage` reports dollars only for `reported` rows and shows the
`unpriced` token share separately, never summed as zero. Size: small. Touches
the parsers in `src/store/model-calls.ts`, the columns, and the `forge usage`
renderer.

**Risks and what not to copy.** Do not zero subscription usage. A
subscription run is `unpriced`, and its tokens stay the budget currency. Do
not add Paperclip's second manual ingest path, which bypasses its own
normalization (`server/src/routes/costs.ts:114-127`). Keep a single writer.
The estimate must not become the enforcement metric by default: recommendation
3's spend guardrails evaluate only `usd_reported`/`derived` on metered
runtimes and `weighted_tokens` elsewhere, never `cost_usd_estimated`.

Forge should not budget subscription runs in dollars, for the same reason
recommendation 3 keeps them on `weighted_tokens`: a subscription seat has no
marginal per-call cost, so a dollar ceiling there measures nothing real.
Paperclip's own zero-cents path (`heartbeat.ts:5213`) hides this by forcing
`subscription_included` usage to a cost of zero — a gap its own eval
discipline calls "unknown, not free" (`doc/evals.md:109-165`), yet the budget
path breaks that rule for subscription billing. The actual constraint on a
subscription rig is the usage window, not a dollar figure, and treating
`cost_usd_estimated` as spend would let two different currencies — a real
metered dollar and a hypothetical subscription dollar — corrupt the same
total.

**Priority.** P1.

### 3. Spend guardrails as admission tests

**Pattern.** Paperclip keeps spend policies per company, agent and project,
with a calendar-month or lifetime window, a warn percentage, and a hard stop
(`packages/db/src/schema/budget_policies.ts:9-41`). Each cost event is written
to a ledger (`cost_events`) and evaluated synchronously against every
matching policy. A soft crossing opens a deduplicated incident. A hard
crossing opens an incident and a `budget_override_required` approval, pauses
the scope, and cancels active and queued work
(`server/src/services/budgets.ts:214-260,380-393`). The same
`getInvocationBlock` is checked at wake admission, queued-run claim,
continuation and recovery (`budgets.ts:718-864`). Resolution is either
`keep_paused` or `raise_budget_and_resume`. Separately, per-agent daily caps
limit run count and cost (`heartbeat.ts:16596-16720`).

**Why it fits Forge.** Forge has no spend ceiling of any kind (lane D §9).

- `cost_tier` is a label that is never enforced (`src/v2/schema.ts:534-537`).
- `allowed_profiles` and `max_cost_tier` have been "still future" since May
  (`docs/how-to-model-policy.md:547-551`).
- The detached-execution ADR names "a hung agent burning tokens" as a revisit
  trigger (`learnings/decisions/2026-07-12_detached-agent-execution.md:110`).

With an armed dispatcher and campaigns, Forge now runs unattended long enough
for this to matter. `forge-feature-opportunities.md` does not list budgets.

**Invariant reconciliation.** Paperclip's hard stop cancels running work.
Forge's invariant 23 says "Disable and capacity reduction are admission tests,
never reapers". A budget ceiling is a capacity reduction, so in Forge a
breach:

- refuses new admissions;
- raises an Attention Inbox item;
- leaves running work to finish or to an explicit `forge cancel` by the
  operator.

Invariant 15 is served by making the override an operator CLI act, never an
agent act.

**Proposed shape.**

- **Policy source.** Budgets are declared in `model-policy.yml` under a new
  `budgets:` block, whose migration authority is `forge upgrade` (invariant 7).
  Each entry has a scope (`host | project | workflow | role`), a window
  (`day | calendar_month`), a metric (`weighted_tokens` or `usd_reported`),
  `warn_percent`, and `hard`.
- **Enforcement points.** One pure evaluator over `model_calls` is called at
  three existing admission points:
  - the pre-spawn refusal list in `runContainer` (`src/v2/runNext.ts:4605-4657`),
    as a new refusal `budget_exceeded`;
  - `claimNextEligible`, as a new `ScanReason` `budget`;
  - campaign `start` and `resume`.
- **Incidents.** A `budget_incidents` table, deduplicated per policy, window
  and threshold by a partial unique index, is rendered as an Attention Inbox
  source.
- **Override.** `forge budget raise <policy> --amount --operator` records a
  RECORDED override. No agent path can call it.

**Where dollars are enforceable today.** On `aws-bedrock` runtimes every token
is metered, so a `usd_reported` ceiling is derivable from a price table the
moment recommendation 2 lands `cost_status = derived`, even on a run where the
CLI's own `total_cost_usd` is absent or not Bedrock-priced. On `oauth-volume`
(subscription) runtimes there is no metered dollar figure at all; tokens stay
the budget currency there, as they do today, though recommendation 2's
`cost_usd_estimated` still reports what that usage would have cost at API
rates, for operator visibility only, never for enforcement. So once
recommendation 2 lands,
`usd_reported` ceilings are enforceable on Bedrock hosts and `weighted_tokens`
ceilings are enforceable everywhere — dollars are not a uniformly aspirational
metric here, they are enforceable exactly where billing is metered.

Size: medium. Depends on recommendation 2 for the dollar metric; the
`weighted_tokens` metric works without it.

**Risks and what not to copy.** Do not cancel running containers
automatically. Do not keep Paperclip's denormalized `spent_monthly_cents`
counters beside the ledger, because they can drift; compute from `model_calls`
at evaluation time. Do not budget subscription runs in dollars. Price in
dollars only where a runtime reports cost, and never let `unpriced` read as
zero. Usage is captured after the container exits
(`src/v2/runNext.ts:5123,5133`), so one run can overshoot a limit. Say so in
the docs; do not add mid-run token metering.

**Priority.** P1.

## P2 — Should

### 4. Status-domain guard for enum-as-convention columns

**Pattern.** Both codebases store status columns as plain `text` and enforce
the set of legal values only in application code, not in the database — call
it enum-as-convention. Paperclip lists its wakeup-request statuses in a
TypeScript `as const` array, `WAKEUP_REQUEST_STATUSES`
(`packages/shared/src/constants.ts:907-916`); the database column itself will
accept any string at all. The database can't stop a bad write; only the code
writing to it can, and only if every writer goes through a path that checks.

That's exactly where Paperclip's `setWakeupStatus` fails. Its `status`
parameter is typed as plain `string`, not the `WakeupRequestStatus` union, so
TypeScript's compiler has nothing to reject (`heartbeat.ts:13041-13049`). Run
finalization then calls it with `outcome === "succeeded" ? "completed" :
status`, where `status` is the *run's* status, not a wakeup status
(`heartbeat.ts:24981-24983`). Run statuses include `timed_out` and
`interrupted`, neither of which is a legal wakeup status. So when a run times
out, `timed_out` — a value from the wrong vocabulary — lands in the
`agent_wakeup_requests.status` column. TypeScript didn't catch it because the
parameter was typed as `string`; Postgres didn't catch it because the column
is untyped text. Every later reader that switches on the eight documented
wakeup statuses now has to handle a ninth value nobody told it about.

**Why it fits Forge.** Forge makes this same trade deliberately, for a real
reason: a CHECK constraint would break the "an old and a new binary can share
`~/.forge/forge.db`" guarantee, since SQLite cannot widen a CHECK once one
exists, and an old binary would reject values a newer binary legitimately
writes (`src/store/schema.ts:394-396`, `1694-1697`; FG-585). So legality is
enforced entirely by accessors that "refuse by name" instead of by a database
constraint — the same trade Paperclip made, and Paperclip's bug is what
happens when one writer skips the accessor. Forge has the same shape of
columns today: `tasks.status`, `queue_claims.state`, continuation state, and
the orchestrator-receipt vocabularies are all unconstrained text guarded only
by convention. A single raw `UPDATE` that writes a value from the wrong
vocabulary — the same mistake Paperclip made — would succeed silently.

**Proposed shape.** Two checks, chosen because each is cheap relative to what
it catches, and neither reintroduces a database constraint.

1. A unit-tier test that scans `src/store/**` for raw `UPDATE … SET <status
   column> =` and `INSERT` statements whose value isn't drawn from the
   column's own vocabulary constant, with an allowlist for the accessors
   themselves. This is the same class of bug as Paperclip's — a value from
   the wrong vocabulary reaching the right-looking column — caught at PR time
   instead of in production. Forge already polices repository rules this way
   (`src/test-tiers.test.ts`), so this adds a rule, not a new mechanism.
2. A `forge doctor` read-only probe, one `SELECT status, COUNT(*) ... WHERE
   status NOT IN (<vocabulary>)` per status column, that reports rows already
   out of domain — drift left behind by an older binary or a past bug. It
   only reports, never repairs, so it can't compromise the accessor-only
   write path that invariant 1 depends on.

Size: small.

**Risks.** Do not add CHECK constraints — that's the one fix this
recommendation deliberately avoids, since SQLite can't widen a CHECK on the
additive-only path Forge relies on (FG-585). The two checks above are placed
exactly where the cost is affordable: at the code that writes, and in a
diagnostic that only reads.

**Priority.** P2.

### 5. Lock the container MCP surface with `--strict-mcp-config`

**Pattern.** Paperclip launches Claude with `--mcp-config <managed> --strict-mcp-config`
(`packages/adapters/claude-local/src/server/execute.ts:904`), so only servers
the control plane chose can load. It also quarantines tool definitions that
change on refresh (`server/src/services/tool-access.ts:7435-7470`).

**Why it fits Forge.** Forge gives containers no MCP configuration and
isolates settings with `--setting-sources ""` (`src/v2/spawn.ts:1347`). A
search of `src/` and `seeds/` finds no `--strict-mcp-config`. The container
works in `/project`, so a checked-in project `.mcp.json` is inside the mount.
The synthesis did not verify whether the current flags already stop it from
loading. That question should be settled by a test, not by reasoning.

**Proposed shape.** First add an integration test in which a fixture project
checks in an `.mcp.json` and the test asserts that no server starts in the
container. If the test fails, add `--strict-mcp-config` with an empty managed
config to the claude runtime invocation block in `seeds/runtimes/claude-*.yml`,
and add the Codex equivalent where one exists. Record `mcp: none` in the
control-plane receipt. Size: small.

**Risks.** Do not import Paperclip's gateway, profiles or policy engine. Its
first-match-by-priority semantics already contradict its own documentation
(lane B §6). Forge has no use case for governed third-party tools in
containers today, and when one arrives the credential half of it is already
covered by role-scoped secret bindings (recommendation 13) — that should land
before any gateway is considered.

**Priority.** P2.

### 6. Failure-history cooldown in the queue scan

**Pattern.** Paperclip's rewake throttle holds back further event-free wakes
once an agent has two consecutive successful runs on an issue with no issue
progress. The cooldown starts at 120 seconds and doubles up to 30 minutes.
Human comments bypass it, and agent comments deliberately do not
(`server/src/services/issue-rewake-throttle.ts:3-20,27-184`). Liveness
continuations are capped at two, after which the system asks a human
(`server/src/services/recovery/run-liveness-continuations.ts:9-145`).

**Why it fits Forge.** A `launch_failed` release leaves a ticket "immediately
re-claimable" (`src/queue/dispatch-execution.ts:609,658`). The scan vocabulary
has no failure-history member (`src/store/queue-claims.ts:204-226`). With
`max_active_runs` at its default of 1, a persistent cause such as broken auth
or a dependency-environment refusal can make an armed dispatcher claim, fail
and re-claim the same ticket on every tick. The synthesis did not trace
whether a `failed` release is re-claimable in the same way. The gap walk
should confirm that first.

**Proposed shape.** Add a `ScanReason` `cooling_down`, computed inside the
scan from the ticket's recent `queue_claims` releases. After N consecutive
`failed` or `launch_failed` releases, back off exponentially. The `detail`
field carries the streak and the next eligible time, as `ScanEntry.detail`
already does for other reasons. When the streak crosses a threshold, raise an
Attention Inbox item. An operator `forge queue retry <ticket>` clears the
cooldown. Nothing is written on a scan, so the rule stays a pure derivation.
Automatic retry attempts from recommendation 7 count toward the streak like
any other release, so the cooldown is what stops a bounded automatic retry
from becoming an unbounded one. Size: small.

**Risks.** Do not classify progress by reading model prose, as Paperclip's
liveness classifier partly does (`server/src/services/run-liveness.ts:62-77`).
Use only structured release outcomes.

**Priority.** P2.

### 7. Bounded automatic retry for infrastructure-classified failures

**Pattern.** Paperclip separates the *classification* of a failure from the
*mechanics* of retrying it, and bounds every mechanical retry it runs
automatically.

- The heartbeat reaper's bounded transient retry uses a fixed two-step delay
  schedule, `[30s, 30s]`, and records `retryOfRunId` so the new run's lineage
  is queryable (`server/src/services/heartbeat.ts:790-800,15824-15840`).
- Its process-loss retry is capped at exactly one attempt
  (`process_loss_retry_count < 1`, `heartbeat.ts:18841-19330`).
- The recovery service's continuation retry budgets differ by cause: three
  attempts at a 60-second base backoff for transient infrastructure codes, one
  attempt for everything else, and a one-hour backoff for provider quota
  (`server/src/services/recovery/service.ts:522-527`). A budget-exhausted or
  budget-blocked continuation is explicitly non-retryable
  (`recovery/service.ts:490-496`).
- Resource waits (a busy workspace, a busy AI connection) are accounted in a
  separate lane from failure retries, so waiting for a resource never spends a
  failure attempt (`server/src/services/execution-recovery-attempt.ts:34-99`).
- A run whose side effects are uncertain — a legacy execution needing
  reconciliation, an unresolved action-outcome ledger — is routed to operator
  reconciliation rather than blindly retried
  (`server/src/services/legacy-execution-recovery.ts:16-53`;
  `execution-recovery-resolution.ts:26-41`).
- Every adapter result carries a classified `errorFamily`
  (`transient_upstream`, `provider_quota`, `model_refusal`, and the
  refresh-token families; `packages/adapter-utils/src/types.ts:69-84`), so the
  retry mechanics never have to parse a message to decide what kind of failure
  they are looking at.

**Why it fits Forge.** `src/v2/retry-policy.ts` already does the classification
half of this. Its `POLICY` table gives every `FailureKind` a named
`RetryDisposition`, and the kinds that would risk clobbering persisted work
(`orphaned_work_may_persist`, `oom_killed`, `orphaned_needs_finalize`,
`capture_failed`) and the judgment outcomes (`gate_rejected`, `red_blocked`,
`agent_reported_failure`, `integration_failed`) are already marked
`retryable: false`, each with its own advice. The infrastructure kinds
(`pre_container_crash`, `container_crash`, `orphaned`, `result_missing`,
`result_malformed`, `idle_timeout`, `model_error`, `tool_error`,
`integration_gate_timeout`, `lane_taken_over`) are already `retryable: true`
with no advice — nothing an operator needs to decide, just work that needs
re-dispatching. What is missing is a bounded *executor*: today every one of
those infrastructure kinds still waits for a human to type `forge retry`,
because the only executor of `retryPolicy()`'s advice is the CLI command
itself. On an unattended host — an armed dispatcher, a running campaign, a
Bedrock host with no session-wake path — that means work stalls for hours over
failures the policy already says are safe to re-run: a container crash, a lost
result, a provider 5xx. The file's own `RE_DRIVABLE_FAILURE_KINDS` comment
(`src/v2/retry-policy.ts:134-155`) draws the distinction this recommendation
depends on: `retryPolicy()` is an advisory surface, so an unrecognized kind may
default to `retryable: true` at no worse a cost than an imprecise sentence, but
a mutation guard that reopens a settled row must fail closed and be typed as
`Record<FailureKind, boolean>`, so adding a kind without deciding the question
is a compile error, not a silent fall-through. An automatic-retry executor is
exactly that second kind of guard, not the first.

**Proposed shape.**

1. A fail-closed eligibility guard, `AUTO_RETRYABLE_FAILURE_KINDS: Record<FailureKind,
   boolean>` in `retry-policy.ts`, modeled on `RE_DRIVABLE_FAILURE_KINDS` so
   that adding a `FailureKind` without deciding its auto-retryability is a
   compile error. The initial `true` set: `pre_container_crash`,
   `container_crash`, `orphaned`, `result_missing`, `result_malformed`,
   `idle_timeout`, `integration_gate_timeout`, `lane_taken_over`,
   `verification_environment_unavailable`, and `model_error` / `tool_error`
   only when the task's `provider_failure_family` (recommendation 2) is
   `transient_upstream` or `provider_quota`. Everything else is `false`:
   persisted-work-at-risk kinds (`orphaned_work_may_persist`, `oom_killed`,
   `orphaned_needs_finalize`, `capture_failed`), judgment outcomes
   (`gate_rejected`, `red_blocked`, `agent_reported_failure`,
   `integration_failed`), operator-precondition kinds (`auth_missing`,
   `auth_expired`, `auth_injection_failed`, `dirty_publish_target`,
   `publish_base_churn`, `publication_refused`), a `model_refusal`
   `provider_failure_family`, and any `budget_exceeded` refusal from
   recommendation 3.
2. A declared budget, not an implicit one: `retry: { auto: true, max_attempts:
   2, backoff: 60s..5m }` on the workflow step (`seeds/workflows/*.yml`), with
   a model-policy default; `provider_quota` uses a longer backoff floor, as
   Paperclip's own one-hour quota window does. Resource-wait retries
   (`verification_environment_unavailable`) are accounted in a separate lane
   from failure retries, as Paperclip's `execution-recovery-attempt.ts` does,
   so a dependency-provisioning wait never spends a failure attempt.
3. The executor is the controller loop from recommendation 1 (and the
   dispatcher tick when armed). It re-dispatches the *same* task through the
   existing `forge retry` path, so the previous-attempt carry
   (`src/v2/previous-attempt.ts`) and the dispatch receipt apply unchanged. It
   records `retry_of` and the attempt index so the lineage is queryable, as
   Paperclip's `retryOfRunId` is.
4. When the budget is spent, the ticket enters the `cooling_down` scan reason
   from recommendation 6, and an Attention Inbox item names the streak and the
   last failure kind. The operator's `forge retry --force` or `forge recover
   --re-drive` remains the only way past that — the executor never escalates
   its own budget.

**Invariant reconciliation.** Invariant 23 says execution authority is an
explicit, recorded act. An automatic retry satisfies this because it
re-dispatches a task that was already authorized, under a budget declared in
the workflow ahead of time, with every attempt recorded; it never dispatches
new work or claims a ticket that was not already running. Invariant 14's rule
that a terminal state a human chose is never reconciled away is satisfied
because judgment outcomes and human dispositions are in the guard's `false`
set — an automatic retry only ever acts on a state a human never decided.

Size: small-medium. Touches `retry-policy.ts`, the workflow step schema, the
controller loop from recommendation 1, and `src/v2/previous-attempt.ts`'s
lineage fields.

**Risks and what not to copy.** Do not use the advisory `retryPolicy()`
default for the executor's eligibility check — its `??`-driven default to
`retryable: true` is safe as prose and unsafe as a mutation trigger, for the
same reason `RE_DRIVABLE_FAILURE_KINDS` fails closed where `retryPolicy()`
does not. Do not auto-retry anything whose worktree may hold work. Do not let
auto-retries bypass the readiness or budget admission tests recommendation 3
adds. Do not copy Paperclip's `LIKE`-on-log-text detection of exhausted
retries (`attention-exhausted-runs.ts:14-18`); use the structured attempt
record instead.

**Priority.** P2.

### 8. Refuse contradictory auth routing at spawn (`auth_routing_incompatible`)

**Pattern.** Paperclip refuses to launch an agent bound to a managed AI
connection whose configured env also sets a provider-routing flag or a custom
base URL — Bedrock/Vertex/Foundry switches, `ANTHROPIC_BASE_URL`, and the
rest — raising `ai_connection_incompatible` before the run starts
(`server/src/services/ai-connection-runtime.ts:213-227`). The rule exists
because an injected, pre-validated credential must never be silently routed to
a backend it was not validated against.

**Why it fits Forge.** Forge has the same shape of risk without the same
refusal. `detectCredsMode()` auto-selects Bedrock by precedence — an explicit
`CLAUDE_CODE_USE_BEDROCK=1`, or, failing that, an `AWS_PROFILE` env var or an
SSO `[default]` profile in `~/.aws/config` (`src/util/creds.ts:38-66`). That
detection runs independently of which runtime seed a dispatch actually
resolved. A host with `AWS_PROFILE` set in its shell env routes to Bedrock by
this precedence even when the step's resolved runtime seed declares
`auth_strategy: oauth-volume` — nothing in `runContainer` compares the two,
and the control-plane receipt records the seed's declared `authStrategy`
(`src/v2/runNext.ts:5022`) without recording which creds mode actually ran.
The mismatch is invisible until someone reads a bill or a log line that
doesn't match the seed they thought they dispatched under.

**Proposed shape.** Add a pre-spawn refusal to the same refusal list
recommendation 3 already cites (`src/v2/runNext.ts:4605-4657`, inside
`runContainer`, ahead of the container launch): compare the resolved
runtime's `auth_strategy` (`resolveRuntimeMetadata(runtime).authStrategy`)
against `detectCredsMode()`'s result, mapped onto the same vocabulary, and
refuse by name as `auth_routing_incompatible` on a mismatch — mirroring
Paperclip's `ai_connection_incompatible` shape: a named, pre-spawn refusal,
not a post-hoc log grep. Record the resolved creds mode alongside the seed's
declared `authStrategy` in the control-plane receipt, so `forge show`/`forge
explain` can show both values even when they agree. Size: small. Touches the
refusal list in `src/v2/runNext.ts` and the receipt shape in
`src/v2/task-manifest.ts`.

**Risks.** Do not copy Paperclip's managed AI connections or its provider
routing model — Forge has neither. Keep the OAuth volume and the env
allowlist as the only credential model; this refusal only compares what
already exists (the seed's declared strategy, `detectCredsMode()`'s result),
it adds no new credential surface.

**Priority.** P2.

### 9. Typed operator asks with a declared continuation

**Pattern.** Paperclip's `issue_thread_interactions` lets an agent attach a
typed ask to its work item (`packages/db/src/schema/issue_thread_interactions.ts:16-80`;
`constants.ts:259-346`):

- **Kinds:** `ask_user_questions`, `request_confirmation`,
  `request_checkbox_confirmation`, `suggest_tasks`, and others.
- **Statuses:** pending, answered, accepted, rejected, expired, and others.
- **Resolver policy:** anyone, not the creator, or human only. It is forced
  to human only for tool actions and secrets.
- **Continuation:** a declared field, one of `none`, `wake_assignee` or
  `wake_assignee_on_accept`.

Asks are idempotent, and accepted `suggest_tasks` become real issues.
Confirmation that an agent may edit another agent's instructions must come
from a previous run, show a diff, and be consumed once
(`server/src/services/change-consent-gate.ts:114-230`).

**Why it fits Forge.** Forge's human touchpoints sit at step boundaries:
`human` gates with advance, reject or request-changes (`src/v2/gate.ts:9-20`).
A container that needs a decision mid-task can only return `failed` and
describe what it needs, as the non-interactive framing tells it to do
(`src/v2/compose.ts:27-35`). The operator then reconstructs the question from
prose. The Attention Inbox has closed kinds and no typed ask.

**Proposed shape.**

- **Contract.** Extend the `result.json` contract with an optional
  `asks: [{kind, question, options?, resolver}]`, where `kind` is one of
  `question`, `confirm` or `choose`, and `resolver` is fixed to `operator` for
  now. A task returning asks parks in the existing `awaiting_gate` state,
  which avoids a new `tasks.status` that would need an ADR under
  `docs/repo-guide.md:67`. The inbox's `human_gate` projection currently
  resolves the gate kind from the workflow step (`docs/concepts.md:390`), so
  it must also treat an open ask on the task as an operator wait.
- **Storage.** Asks are stored in an `operator_asks` table keyed by task, with
  an idempotency key.
- **Answering.** `forge ask answer <id> --value …` records the answer, then
  re-dispatches through the existing retry path. The answer goes into the task
  package's previous-attempt section (`src/v2/previous-attempt.ts`), next to
  the carried `TASKS.md`.
- **Surface.** Asks become an Attention Inbox source.

Size: medium.

**Risks and what not to copy.** Do not let agents answer each other's asks.
Invariant 15 keeps the resolver human. Do not let accepted suggestions create
tickets automatically; a `suggest_tickets` kind should stage a
`forge backlog file` preview for the operator. Do not copy Paperclip's three
overlapping "changes requested" notions. An ask is not a gate verdict and
never advances publication.

**Priority.** P2.

### 10. Typed recovery records with owner, attempts and outcome

**Pattern.** Paperclip's `issue_recovery_actions` table
(`packages/db/src/schema/issue_recovery_actions.ts:30-63`; `constants.ts:377-415`)
has:

- **Kind:** `stranded_assigned_issue`, `active_run_watchdog`,
  `workspace_validation`, and others.
- **Status:** active, escalated, resolved, cancelled.
- **Owner type:** agent, user, board, system.
- **Outcome:** restored, handed_back, false_positive, escalated, and others.
- **Retry budget:** attempt counts per failure lane, with backoff
  (`server/src/services/recovery/service.ts:522-527`).

A partial unique index allows at most one active record per issue, and a new
failure identity cancels and replaces the old record
(`server/src/services/issue-recovery-actions.ts:243-302`). Closing an issue
that has an active recovery action requires recovery authority. Partial unique
indexes also deduplicate every kind of system-generated recovery issue
(`packages/db/src/schema/issues.ts:137-201`).

**Why it fits Forge.** `forge-feature-opportunities.md` §3 asks for a recovery
gap audit: whether recovery resumed, respawned or only retained evidence. It
proposes no record shape. Forge's orphan kinds and `awaiting_recovery` say
what failed, but not who owns the repair, how many attempts were made, or how
it ended (`docs/concepts.md:678-740`). The new material from Paperclip is the
shape: owner, attempt budget, outcome vocabulary, one active record per item,
and supersede-on-new-identity. That shape turns §3's four audit questions into
queryable facts.

**Proposed shape.** Add a `recovery_records` table keyed to task, with:

- `failure_kind`, reusing the existing orphan kinds;
- `owner` (`operator | forge`);
- `attempts`;
- `outcome` (`resumed | respawned | retained | discarded | false_positive | escalated`);
- `superseded_by`;
- a partial unique index on the active record per task.

`forge recover` and the controller loop from recommendation 1 write the
records. The Attention Inbox and the Run Map read them. Run this after the §3
gap walk, not before it. Size: medium.

**Risks.** Do not add Paperclip's task-watchdog *agent*. That is an LLM
reviewing a stalled subtree, and the prior synthesis rules out persistent
worker pools. Keep recovery deterministic, with the operator as the only
judgment-bearing owner.

**Priority.** P2.

## P3 — Could

### 11. One outbound safe-projection function for notifications

**Pattern.** `projectSafeChatPublicationText` is "the only text projection
allowed to cross" out of Paperclip. It strips reasoning, tool and log content,
redacts credentials, and neutralizes @-all (`server/src/services/chat-publication-projection.ts:152-243`).

**Why it fits Forge.** Forge sends ntfy and SMS text built in
`src/notify/format.ts`. Its env redaction is a fail-closed allowlist on the
container side (FG-707), but outbound notification text has no single
chokepoint that a test can hold to account.

**Proposed shape.** Route every transport through one `projectOutbound(text)`
function. Add a unit test asserting that no transport module imports a
formatter except through it. Size: small.

**Risks.** None of note. Keep notifications outbound-only unless
recommendation 15 lands.

**Priority.** P3.

### 12. Content-hash provenance and a static audit for skills and role seeds

**Pattern.** Paperclip records a `contentHash` for each catalog skill and an
`originHash` for each installed skill. It holds updates when local edits are
detected (`local_modifications`), derives a trust level from contents, and
runs a pre-install byte audit with hard stops for remote-fetch-exec, secret
exfiltration and inventory mismatch (`server/src/services/company-skills.ts:692-730,2516-2635`).

**Why it fits Forge.** Forge already stamps the sha256 of the agent protocol
into each manifest (`src/v2/task-manifest.ts:163-175`), and FG-776/777 back up
host edits before `forge upgrade` overwrites agents. Role seeds and host skills
carry no per-file hash in the receipt, so an Explain view cannot say which
role prose a dispatch ran with.

**Proposed shape.**

- Extend the control-plane receipt with sha256 hashes of the composed role
  seed, the project addendum and the mounted skill directory.
- Have `forge upgrade` report `local_modifications` per file before the
  existing backup.
- Add a static audit to `install-seeds.sh` and `forge upgrade` for the two
  hard-stop patterns that matter to Forge: piping a fetch into a shell, and
  reading credentials.

Size: small.

**Risks.** Do not build a skills store, social layer or per-tenant DB
versioning. Forge's unit is the seed file and its generation.

**Priority.** P3.

### 13. Role-scoped secret bindings

**Pattern.** Paperclip resolves a secret into run env only when a binding row
exists for the specific consumer and config path. `resolveSecretValueInternal`
checks company match, scope, active secret status and active version status,
then calls `assertBindingContext`, which looks up a `company_secret_bindings`
row keyed on `(companyId, targetType, targetId, configPath)` — a unique index
enforced at the schema level, not just in application code
(`server/src/services/secrets.ts:1353-1460`;
`packages/db/src/schema/company_secret_bindings.ts:5-31`; the binding target
vocabulary, including `agent`, is `packages/shared/src/constants.ts:745-760`).
A reserved-key list strips control-plane names such as `PAPERCLIP_API_KEY` out
of run env before any binding can override them (`heartbeat.ts:1460-1471`).
Every resolution writes a `secret_access_events` row, on both success and
failure. The soft spots are as instructive as the pattern:
`assertBindingContext` returns `null` — skipping the binding check entirely —
when no context is passed at all (`secrets.ts:1137`); the local provider
encrypts under one deployment-wide master key with no AAD binding ciphertext
to secret, and stores an unsalted SHA-256 of the plaintext, indexed
(`local-encrypted-provider.ts:98-107`); and the exact-value redaction registry
covers only values an agent fetched through the `/value` endpoint or a
proposal, so an env-bound secret echoed into a log with no recognizable shape
passes through uncaught (`run-secret-redaction.ts:59-147`).

**Why it fits Forge.** Forge's credential model is host-wide and mode-wide,
never per-role. `detectCredsMode()` picks one of `bedrock`, `anthropic-oauth`
or `anthropic-apikey` for the whole dispatch from env and `~/.aws/config`
precedence (`src/util/creds.ts:26-67`), and the resolved runtime seed's
`auth_strategy` (`seeds/runtimes/*.yml`) names which of those the container is
built to expect — there is no notion of "this role gets this credential and
that role doesn't" anywhere in that path. A project's other secrets — a
database URL, a third-party API key — live in a single `.env` today, and
workspace isolation's own contract is all-or-nothing at the mount, not
per-secret: an isolated task workspace is committed content at the base SHA
plus what Forge explicitly supplies, and "uncommitted, untracked and ignored
files … do not reach it" by design (invariant 19) — a canonically gitignored
`.env` is exactly the case that contract excludes, with `FORGE_NO_WORKTREES=1`
as the documented escape when an ignored local input is genuinely required
(`docs/concepts.md` → Workspace isolation). That escape is a blunt instrument:
with isolation off, the container sees the *whole* project, `.env` included,
regardless of which role is running. Either way — isolated and credential-less,
or unisolated and credential-everything — no dispatch today gets a slice. And
where a credential does reach a container, nothing records which one: the
control-plane receipt (`src/v2/task-manifest.ts`) stamps the resolved
`authStrategy` for the runtime, never which project secrets, if any, the
container could see. The operator's stated need is concrete: restrict
credentials to specific agent roles, so a db-admin role can receive Supabase
credentials while a senior-engineer role on the same project does not — a
binding-row-required resolution is exactly the shape that answers it. This is
also the credential half of what Paperclip's MCP tool gateway does (lane B
§6) — the gateway's job is governing which external *tools* a role can call
once it is authenticated; role-scoped secret bindings is the half Forge would
need *first*, before any tool gateway is worth considering, because a role
cannot call an external service at all without a credential to call it with.

**Proposed shape.**

- **(a) Declaration.** A project-level `secrets:` block in `.forge/config.yml`
  names each secret and its source — first a host-side file outside the repo
  under `~/.forge/secrets/<project_key>/`, with an OS keychain or AWS Secrets
  Manager as a later source, mirroring Paperclip's own local-vs-managed
  provider split without its in-database ciphertext store. A `bindings:` block
  maps role to secret names, optionally narrowed further per workflow step —
  the role-to-secret edge the operator described (db-admin bound to Supabase
  credentials, senior-engineer not bound to them).
- **(b) Resolution at spawn.** Bindings resolve host-side when a task is
  spawned: only the secrets bound to the resolved role are injected into that
  container's env. The agent never fetches a secret itself — there is no
  in-container call to a secret store, which keeps invariant 20 ("a container
  never reaches the host store") true for secrets the same way it already is
  for ticket data.
- **(c) Pre-spawn refusal.** A workflow step that declares `requires_secrets:`
  naming a secret the resolved role is not bound to refuses before the
  container starts, as `secret_unbound`, in the same pre-spawn refusal list
  recommendations 3 and 8 already cite (`src/v2/runNext.ts:4605-4657`, inside
  `runContainer`) — a named refusal, not a container that starts and then
  fails opaquely for lack of a credential.
- **(d) Reserved-key strip.** A project secret can never override a
  control-plane env name — `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`, `FORGE_*` are
  reserved, the same discipline as Paperclip's `FORBIDDEN_ENV_BINDING_KEYS`
  (`heartbeat.ts:1460-1471`).
- **(e) Receipt and redaction.** The dispatch receipt records binding NAMES,
  never values — the same "reference, not material" discipline the `auth`
  block of `manifest.json` already applies to auth profiles
  (`docs/redaction.md` → Manifest). Each resolution writes a `secret_access`
  event, mirroring Paperclip's `secret_access_events` audit. Bound values are
  registered with the existing redaction machinery — the FG-707 fail-closed
  allowlist that already redacts everything not explicitly known-safe on the
  durable launch record, and the FG-634 `redactSecrets` sweep
  (`src/v2/host-readiness.ts`) already reused across the config graph and Run
  Map/Explain surfaces — so logs, launch records and `result.json` cannot echo
  a bound value even by accident.
- **(f) Operator-only edits.** Bindings are edited only by the operator,
  never proposed by an agent (invariant 15) — unlike Paperclip's
  agent-submitted secret proposals for board approval
  (`server/src/routes/secrets.ts:194-311`), which Forge has no board to route
  through and no reason to add one for.

Size: medium. Touches `.forge/config.yml`'s schema, the refusal list and spawn
env assembly in `src/v2/runNext.ts`, the receipt shape in
`src/v2/task-manifest.ts`, and a new binding-resolution module alongside
`src/util/creds.ts`.

**Risks and what not to copy.** Do not build an encrypted-in-database secret
store with a deployment-wide master key — Forge's source is a host-side file
or OS keychain the operator already controls, not a value forge itself
encrypts and stores, so there is no master key to lose or rotate. Do not add
Paperclip's agent-submitted secret-proposal flow. Do not add user-scoped
secrets; Forge is single-operator by design
(`src/v2/host-readiness.ts:236`), so there is no second human to scope a
secret to. Do not copy Paperclip's context-optional resolution path — its own
binding check is skipped outright when no context is passed at all
(`secrets.ts:1137`); Forge's resolution must be mandatory on every path that
injects a secret, never an implicit allow when a caller forgets to pass
context. Do not carry the whole `.env` into a container as a substitute for
per-role binding — that all-or-nothing mount is exactly the state this
recommendation replaces. Keep isolation-on as the default so an unbound
secret is not reachable through the mount either: with isolation off
(`FORGE_NO_WORKTREES=1`), the container already sees the whole project
including `.env`, and a binding layer sitting on top of a fully exposed mount
enforces nothing.

**Priority.** P3 — becomes P2 the moment any role is expected to call an
external service with a credential.

### 14. Scheduled triggers that file and enqueue, never dispatch

**Pattern.** Paperclip's routines materialize a schedule, webhook or API
trigger into an ordinary issue (`server/src/services/routines.ts:1712-2050,3175-3294`).
The issue carries an origin fingerprint and follows a declared concurrency
policy: `coalesce_if_active`, `skip_if_active` or `always_enqueue`. Catch-up
is bounded, and a partial unique index keeps at most one open issue per
routine. Webhooks are HMAC-signed with a replay window.

**Why it fits Forge.** Forge has no cron, launchd or webhook starts (lane D
§5). Recurring hygiene work, such as dependency audits, docs-drift sweeps and
the doc/code drift list in the companion assessment, is filed by hand.

**Invariant reconciliation.** Invariant 23 says enqueuing never authorizes a
container. A Forge trigger may therefore file a ticket from a template and
enqueue it. Execution still requires the armed dispatcher or an operator. This
is a stricter shape than Paperclip's, where routine issues wake agents
directly.

**Proposed shape.**

- A `triggers:` section in project config, with a cron expression, a ticket
  template path, a concurrency policy and a catch-up cap.
- A `forge triggers tick` verb, run by the controller loop from
  recommendation 1, that files and enqueues due tickets.
- An `origin_fingerprint` column on `tickets` with a partial unique index on
  open tickets per trigger.

Size: medium. No webhooks in the first slice, because Forge has no inbound
listener apart from the remote board.

**Risks.** Do not dispatch from a trigger. Do not let triggered tickets bypass
readiness assessment; the queue scan already refuses `readiness_ineligible`.

**Priority.** P3.

### 15. Answer operator asks from a phone with opaque expiring tokens

**Pattern.** Paperclip renders `ask_user_questions` and `request_confirmation`
as native chat buttons behind opaque seven-day action tokens
(`server/src/services/chat-interaction-publications.ts:1-31`;
`chat-question-forms.ts:21-30`). While an ask is pending, run prose stays
internal. Paperclip's own qualification says no provider is
production-qualified, so the product evidence is thin. The token pattern is
the part worth taking.

**Why it fits Forge.** Forge's notifications are outbound only, with no reply
or acknowledgement channel (lane D §6). The remote board already verifies
identity at the transport and permits only `read | plan`
(`dashboard/src/remote/identity.ts:1-44`).

**Proposed shape.** Only after recommendation 9 exists, a notification for an
operator ask carries a link to the remote board. The link includes an opaque,
single-use, short-lived token bound to the ask id and the expected answer
domain. The remote board adds one capability, `answer_ask`, which shells out
to `forge ask answer` (invariant 10). Gate advance, publication, cancel and
close remain impossible remotely, as the remote-board decision
record requires (`learnings/decisions/2026-09-08_remote-board-planning-mutations.md`). Size:
medium.

**Risks.** Do not build chat connectors. Paperclip's 38k-line subsystem is
unqualified on every provider. Do not accept SMS replies as answers; there is
no identity binding on SMS.

**Priority.** P3.

### 16. Policy evals: scenario × profile matrix with hard gates

**Pattern.** Paperclip's eval kernel is 98 lines that run scenario × candidate
cells: preflight, execute, score (`packages/paperclip-eval-kernel/src/index.ts:40-98`).
Workflow scoring applies hard gates first, and any failure scores the cell
zero. Weighted dimensions follow (`packages/paperclip-runner/src/eval/workflow-scoring.ts:20-29,147-166`).
Its hygiene rules include never merging partial campaigns into one score,
treating missing cost as unknown, and keeping presentation separate from the
source of truth.

**Why it fits Forge.** `forge-feature-opportunities.md` §8 already proposes
outcome-informed analytics over *observed* runs. Paperclip adds a
*controlled* complement: replaying a fixed scenario set against two
model-policy profiles or effort levels, so a routing change is justified by a
comparison rather than by production drift. Forge's per-test evidence parsing
(`src/v2/review-evidence.ts`) is a natural hard gate.

**Proposed shape.** A `forge eval run --scenarios <dir> --profiles a,b`. It
dispatches each scenario through the normal pipeline per profile, scores each
cell with hard gates (tests executed and passed, reds not failing) and then
with usage from recommendation 2, and writes results to an `eval_cells` table.
Size: large.

**Risks.** This costs real money and time. It should wait until budgets
(recommendation 3) can cap it. Keep results advisory, as §8 already requires.

**Priority.** P3.

## Explicitly Decline

**Persistent employees on heartbeat timers.** Timer-woken, long-lived agents
with an org chart, a manager and a budget (lane A §1, §3) would add a standing
actor class. They would also collide with invariant 23: execution authority is
an explicit, recorded act. The prior synthesis already declines persistent
worker pools. Paperclip's rewake throttle, its liveness continuations and its
recorded 25-session recovery show the maintenance cost of that model.

**An agent-callable control-plane API.** Paperclip's runner exposes 35
semantic operations. They include `create_task`, `hire_agent`,
`reassign_task`, and a generic `search_api`/`call_api` into the real HTTP
router, authorized by a run-scoped JWT (`doc/runner-api-tools.md`;
`server/src/services/native-runtime/paperclip-runner-tool-authority.ts:81-88`).
Forge containers never reach the host store (invariant 20), and all mutation
goes through the Forge control plane (invariant 10). Recommendation 9 gets the
useful half, structured requests from an agent, through the `result.json`
contract without a callback channel.

**Claim-based completion.** Paperclip auto-derives completion criteria from an
issue's title and lets the agent's claim close low-risk work
(`server/src/services/native-runtime/completion-contracts.ts:38-92`). This
contradicts invariant 11 directly.

**Multi-tenant RBAC and the responsible-user model.** Companies, memberships,
21 grant keys and permission intersection are well engineered (lane A §1), but
Forge is single-operator by design (`src/v2/host-readiness.ts:236`). If a
second human approver is ever wanted, study the responsible-user intersection
then. It should not be pre-built.

**Heuristic liveness over model prose.** Paperclip classifies runs as
`plan_only` or `empty_response` partly by regular expressions over output
(`server/src/services/run-liveness.ts:62-77`), and finds exhausted retries by
a `LIKE` over log text (`attention-exhausted-runs.ts:14-18`). The prior
synthesis already declines "tmux, PTY text, or agent self-report as task
truth".

**In-process plugin and adapter installation.** `POST /adapters/install`
installs a package from npm and imports it into the server process without
isolation (`server/src/adapters/plugin-loader.ts:149-195`). The plugin
capability list includes `approvals.respond` and `authorization.grants.write`,
against Paperclip's own spec (`constants.ts:1362-1384`). This would move
authority out of the DB-authoritative ledger into third-party code. Forge's
atomic seed generations are the right extension unit.

**A goal hierarchy as stored data.** Paperclip's goal tree is auto-filled,
carries no invariants, is absent from the wake prompt, and is flagged off in
the UI (lane A §2c). If Forge wants "why" context, it should inject the
ticket's epic and problem statement into the task package rather than add a
goal table.

**Board columns as execution state and loose transitions.** Paperclip does not
enforce its documented issue transition matrix (`server/src/services/issues.ts:302-307`).
Forge's CAS state machines and ADR-guarded status set are a deliberate
advantage. The prior synthesis already declines mutable board columns as
canonical state.

**Four approval mechanisms.** Approvals, execution stages, thread
interactions and decisions overlap, with three notions of "changes requested"
(lane A §4). Forge should keep gates plus the one ask type in recommendation
9. The prior synthesis warns about exactly this vocabulary density.

**A writable audit log.** Paperclip lets board actors insert activity rows
with a caller-chosen actor (`server/src/routes/activity.ts:92-100`). Forge's
events table has one writer, and it should stay that way.

**Zero-priced subscription usage.** See recommendation 2.

## Suggested First Tickets

1. Add a supervised `forge reconcile watch` loop over active runs and a `ready`-continuation drain, with a `forge notify milestone` on completion, a launchd template and a `forge doctor` check
2. Record cost status, billing mode and reported USD in `model_calls`; show unpriced usage separately in `forge usage`
3. Add spend guardrails from `model-policy.yml` as pre-spawn, queue-claim and campaign admission refusals, with Attention Inbox incidents
4. Add a unit-tier guard against raw status writes outside the store vocabulary accessors, and a `forge doctor` out-of-domain probe
5. Prove with a test that a checked-in `.mcp.json` cannot load in agent containers, and pass `--strict-mcp-config` if it can
6. Add a `cooling_down` queue scan reason after consecutive failed or launch_failed releases
7. Add an `AUTO_RETRYABLE_FAILURE_KINDS` guard to `retry-policy.ts` and a bounded automatic-retry executor in the controller loop, with a declared per-step retry budget
8. Add a pre-spawn `auth_routing_incompatible` refusal that compares `detectCredsMode()` against the resolved runtime seed's `auth_strategy`, and record the resolved creds mode in the control-plane receipt
9. Correct the sudo description in `docs/repo-guide.md:69` and the other lane D doc/code drift items
10. Add typed operator asks to the `result.json` contract, routed through `awaiting_gate` and the Attention Inbox
11. Add a `secrets:`/`bindings:` block to `.forge/config.yml`, a `secret_unbound` pre-spawn refusal, and host-side binding resolution at spawn that injects only a role's bound secrets into container env
