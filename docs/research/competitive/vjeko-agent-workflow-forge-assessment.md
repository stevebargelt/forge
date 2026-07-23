# “I Don’t Trust My Agents Either” — Forge Workflow Assessment

Date: 2026-07-22

Source reviewed:

- Vjeko, [“I don’t trust my agents either”](https://vjeko.com/2026/07/21/i-dont-trust-my-agents-either/),
  published 2026-07-21.

This is a comparative workflow analysis, not an implementation plan or a binding Forge architecture
decision.

## Executive Take

The article’s central claim is closely aligned with Forge: reliable agentic engineering does not come
from trusting an agent or repeatedly inspecting its output. It comes from a repeatable system that
constrains the work, demands falsifiable evidence, places focused review at the earliest useful boundary,
and stops when its existing rules cannot safely classify or correct a failure.

The workflow is substantially more disciplined than “use several reviewer agents.” It gives fresh agents
different, narrow objectives: specification fidelity, test validity, coverage, security, and other named
failure classes. Each receives a purpose-built checklist and limited context. That provides meaningful
independence of context and review objective even when the agents use similar underlying models.

Forge already shares much of this philosophy: declarative workflow DAGs, architecture and planning
phases, role-specific agents, read-only adversarial reviewers, verdict gates, bounded review loops,
RED-before-GREEN falsification expectations, and durable execution evidence. Forge is stronger on
crash/restart recovery, concurrency, provenance, lifecycle authority, and durable control-plane state,
which the article does not address in depth.

The article also exposes a real Forge limitation. Forge workflows are easy to rearrange, but hard to give
new mechanically enforced semantics. A superficial red/green workflow could be expressed in YAML quickly.
The workflow described in the article could not: Forge cannot currently declare and enforce “tests only,”
“production code frozen,” “these exact test bytes are immutable during green,” or “this red counts only if
the intended assertion failed.” Adding those honestly would be a multi-day platform change rather than a
small workflow edit.

That work is strategically interesting but is not the next priority. After FG-583 closes the
durable-continuation foundation, Forge’s current plan is to shift toward operator work management
(FG-496/FG-591/FG-593). Declarative phase-mutation and red/green evidence contracts remain a future
direction, not another prerequisite added to the foundational critical path.

## The Workflow Described

The article presents three main acts, followed by a process-improvement loop.

### 1. Refuse To Start Blind

The workflow reads a specification and decomposes it into the smallest units that can be independently
built and tested. It constructs a dependency graph so prerequisites run first and independent units may
run in parallel.

If a requirement is too vague to become a test, the workflow stops rather than guessing.

Before implementation, it settles a mocking strategy for every unit:

- what is tested in isolation;
- which dependencies are mocked;
- where those mocking boundaries sit;
- how isolated pieces will later be reconnected.

It then produces a nonfunctional skeleton with the intended public shape but no behavior. The skeleton is
reviewed before tests or implementation are built on top of it. That review asks:

- Does the structure match the specification?
- Is every required behavior represented?
- Did the design add behavior the specification did not request?
- Can tests exercise the intended seams?

This is an important ordering choice. A testable skeleton of the wrong system is still wrong, and every
subsequent test would faithfully reinforce that initial mistake.

### 2. Build, Then Re-Prove

The workflow uses a stricter interpretation of red/green/refactor than ordinary prompt-level TDD.

#### Red

A test must establish a real GIVEN–WHEN–THEN tension:

- GIVEN defines the starting world.
- WHEN performs the missing behavior.
- THEN asserts the state that only the intended behavior should produce.

The test runs against the inert skeleton. It counts as red only when it reaches the intended assertion and
fails because the behavior did not close the GIVEN-to-THEN gap. A compile error, fixture failure, crash,
environment error, or deliberately false assertion is not acceptable red evidence.

A fresh, narrow reviewer is dedicated to detecting vacuous reds. Its job is not to review the whole
implementation. It determines whether each test genuinely demonstrates missing behavior and refuses the
stage when it does not.

During red, the test may change but the production implementation is frozen.

#### Green

The implementation agent writes the smallest behavior needed to satisfy the accepted red. During green,
the tests are frozen. This prevents the implementer from weakening or rewriting the test to manufacture a
pass.

The trust claim rests on the bound transition:

1. a specific unchanged test failed for the intended reason;
2. production behavior changed;
3. the same test passed.

#### Refactor And Integration

The implementation is then cleaned up without changing behavior, while tests remain green.

The workflow does not perform a full-suite run after every small edit. It runs narrow tests at strategic
points, the complete suite before completion, and integration tests with mocks removed so independently
correct pieces must communicate through their real boundaries.

### 3. Try To Prove The Result Wrong

There is no single general review agent. The workflow uses a panel of fresh, narrow reviewers, each
isolated from the implementer’s context and from the other reviewers:

- specification fidelity;
- whether tests test what they claim;
- coverage;
- security;
- other explicitly named concerns.

Review is distributed throughout the workflow rather than reserved for the end. The plan, mocking
strategy, skeleton, red evidence, implementation, and integrated result are checked at the earliest stage
where the relevant evidence exists.

Each confirmed finding goes to a fixer that makes the smallest appropriate change. Only affected checks
run immediately; broader regression checks run at the appropriate later boundary. Reviewers return after
the correction. If a fixed number of attempts cannot close the findings, the workflow stops and asks the
operator.

### 4. Convert Novel Stops Into Process Improvements

The article treats an unexpected stop as evidence that the workflow admitted a class of failure it did
not know how to prevent. The response is not merely to patch the instance or authorize an agent to fix
anything that appears obvious. The operator asks why the process allowed the class through and adds a
reusable prevention or detection mechanism.

This is the article’s Deming-inspired quality argument: quality is built into the process rather than
inspected into the final diff.

## Why The Reviewer Panel Is Meaningfully Better

The reviewer panel should not be dismissed as repeated generic LLM approval. It creates real separation
along several axes.

| Independence dimension | Assessment |
|---|---|
| Context independence | Strong: reviewers are fresh and do not inherit the implementer’s reasoning or attachment |
| Objective independence | Strong: each reviewer searches for a different named failure class |
| Checklist independence | Strong: each role applies a purpose-built rubric rather than a general “looks good” judgment |
| Sampling independence | Partial: fresh executions can vary, but may still share systematic reasoning patterns |
| Model/provider independence | Not established by the article |
| Evidence-method independence | Mixed: some reviews reason over the same specification, code, and tests |

Fresh context reduces anchoring, sunk-cost reasoning, and self-review. Narrow objectives reduce cognitive
overload and make omissions more visible. A security reviewer and a test-validity reviewer are not voting
on one question; they are trying to falsify different claims.

The remaining qualification is correlation. Agents trained similarly can share blind spots even when
their prompts differ. They can all accept the same flawed specification, mock boundary, or abstraction.
Several reviewers can miss a concurrency defect when none has an executable interleaving test.

Confidence therefore grows most when narrow review roles are paired with distinct evidence mechanisms:

- compiler and type-system checks;
- mutation tests;
- assertion-specific red evidence;
- hostile fixtures;
- property-based tests;
- crash and interleaving injection;
- real CLI and filesystem paths;
- integration tests with mocks removed;
- static security analysis;
- host verification where the host boundary matters.

The number of passing agents is not itself a confidence metric. The useful measure is the set of distinct
claims proven through appropriately different failure-detection methods.

## The Narrowness Tradeoff

Being “blind to everything else” improves focus, but it can hide failures that live between concerns.

A defect may emerge only from the interaction of:

- lifecycle state;
- filesystem publication;
- recovery behavior;
- authorization;
- concurrency;
- operator-visible reporting.

No narrow reviewer may own that entire interaction. A focused panel should therefore be complemented by
one cross-cutting integration reviewer. That reviewer does not replace specialists; it inspects the seams
they were deliberately prevented from seeing.

## Where Forge Already Aligns

### Declarative Sequencing And Decomposition

Forge workflow YAML already describes steps, dependencies, gates, reds, and fanout. The feature workflow
uses architect, plan, build, verify, and docs phases, and the plan can fan out into independent
implementation steps.

Relevant surfaces:

- `seeds/workflows/feature.yml`
- `src/v2/schema.ts`
- `src/v2/runNext.ts`

### Fresh, Role-Specific Adversarial Review

Forge has distinct red roles for broad, narrow, frontend, backend, and security concerns, plus the
Shipping Reviewer. Red agents receive read-only project mounts and do not see other panel members’
findings while reviewing.

This is philosophically close to the article’s reviewer fleet. Forge’s recent experience confirms the
value: focused review has repeatedly caught production-path, trust-boundary, and concurrency defects that
the main build pipeline missed.

### Gates And Bounded Correction

Authoritative red verdicts can block workflow progress. The review-loop uses finding-indexed correction,
re-review, and bounded rounds rather than letting the original implementer declare its own work complete.

The bounded stop is especially important. Recent Forge runs have shown both outcomes:

- review converges from structural failures toward small residuals;
- repeated findings expose a recurring architectural class, at which point another local patch would
  accrete containment machinery.

### Falsification Expectations

Forge increasingly requires evidence that a regression test was observed red against the pre-fix
behavior before it became green. Several foundational tickets also use mutants, crash injection, real
processes, and production-path tests to prove detection power.

### Durable Control And Recovery

Forge goes substantially beyond the article in areas required for unattended operation:

- durable run, task, event, continuation, and campaign identity;
- exactly-once claims over at-least-once wakes;
- crash and restart recovery;
- atomic publication;
- worktree and candidate validation;
- runtime and release provenance;
- explicit terminal dispositions;
- reconciliation against durable evidence;
- read-only reviewer mounts;
- bounded retry and operator escalation.

The article describes a quality workflow. Forge must operate both a quality workflow and a durable,
recoverable control plane.

## The Forge Workflow-Extensibility Gap

Forge’s current workflow schema can express:

- agent role;
- activity/model intent;
- dependencies;
- human, verdict, automatic, or absent gates;
- workflow-specific prompt additions;
- reds;
- fanout.

It cannot declare:

- this step may modify tests only;
- this step may modify production code only;
- these exact files or artifact hashes are frozen;
- the next step must consume the precise artifact produced by the previous step;
- this command must fail at a named assertion to count as red;
- compilation/setup/environment failures do not satisfy the transition;
- the same unchanged test must move from accepted red to green;
- a reviewer must demonstrate the test’s detection power by mutation.

Current primary workflow agents receive a read-write project mount. Red agents receive a read-only mount.
There is no intermediate mechanically enforced “test-writer with production code frozen” mode. The
feature workflow’s build phase normally permits implementation and tests together; its verify phase writes
integration/E2E tests after implementation already exists.

### What Would Be Easy But Misleading

Forge could quickly add this sequence:

```text
plan → test-writer → vacuous-red-reviewer → implementer → reviewer panel → verify
```

Without new enforcement primitives, that would remain prompt discipline:

- the test writer could change production code;
- the implementer could soften tests;
- a compile or fixture failure could be reported as red;
- the reviewer could approve prose without executing a detection-power check;
- retries could lose which test revision was frozen.

It would copy the article’s terminology without reproducing its trust argument.

### What An Honest Implementation Would Need

A reusable design would likely require:

1. **Phase mutation scopes** — declarative `tests-only`, `production-only`, `docs-only`, or explicit path
   policies, enforced from the before/after tree rather than agent self-report.
2. **Frozen artifact binding** — hashes or revisions for accepted tests and other protected artifacts,
   checked before green can complete.
3. **Structured red evidence** — command, exit status, failure classification, assertion identity, and
   captured output sufficient to distinguish behavioral red from setup failure.
4. **Detection-power review** — a narrow agent or mechanical mutation that proves the test fails when its
   WHEN/behavior is removed or altered.
5. **Green transition proof** — the exact accepted red artifact passes after production-only changes.
6. **Recovery semantics** — retries and restarts preserve mutation scope, frozen artifacts, red evidence,
   and lineage.
7. **Cross-cutting final review** — integration review after the deliberately narrow phase reviewers.

The architectural opportunity is broader than one TDD workflow. If phase mutation and evidence contracts
became declarative, Forge could cheaply express migration-only, docs-only, policy-only, generated-artifact,
and other restricted workflows. The reusable primitive is more valuable than a hard-coded
“Vjeko red/green workflow.”

## Risks In Applying The Article Too Literally

### Gate Count Is Not A Defect Rate

The Six Sigma analogy is useful rhetoric about process discipline, but the article does not establish an
actual defect rate, reviewer independence, or calibrated escape probability. Correlated checks cannot be
multiplied as though every pass were statistically independent.

Forge should measure detection power through seeded defects, mutants, historical regressions, and escape
analysis rather than counting agents or gates.

### Early Mocking And Skeleton Decisions Can Freeze The Wrong Abstraction

Settling mocks and structure before logic improves discipline, but it can also make an early decomposition
expensive to challenge. Skeleton review must remain empowered to reject the architecture, not merely
approve its testability.

Integration evidence should be allowed to invalidate the mocking strategy when the real boundaries
behave differently.

### Every Stop Should Not Become Permanent Machinery

Forge strongly agrees with fixing classes rather than chasing instances. Recent foundational work also
shows the danger: each local detector or containment patch can create another adjacent crash window,
leading to a treadmill of increasingly specialized machinery.

The proportional response to a stop may be:

- move the invariant to a stronger boundary;
- replace several guards with one atomic construction;
- correct a workflow rule;
- improve a test or reviewer;
- record and defer a low-impact limitation;
- accept a documented product boundary.

“Learn from every stop” is valuable. “Implement every possible prevention immediately” would keep Forge
in foundational work indefinitely.

### Production Trust Extends Beyond Code Quality

The article’s provocative “commit and push to master” framing depends on important surfaces it does not
fully specify:

- deployment authorization;
- rollback;
- database and schema compatibility;
- production observability;
- secret and permission boundaries;
- supply-chain provenance;
- concurrent writers;
- recovery after partial publication;
- durable evidence of what actually shipped.

Strong code-review workflow is necessary but not sufficient for safe production autonomy.

## Decision For Forge

The article validates several existing Forge directions:

- fresh, narrow, adversarial reviewers;
- evidence-specific gates;
- review at the earliest meaningful boundary;
- honest RED-before-GREEN falsification;
- bounded correction and operator escalation;
- closing recurring defect classes at the right invariant boundary.

It also identifies a legitimate future platform capability: declarative phase mutation and evidence
contracts.

That capability is deliberately deferred. FG-583 is the final child of the current
durable-continuation/promotion foundation. Once it and its parent chain close, Forge should move toward the
operator work-management plan:

1. FG-496 — DB-backed backlog, rank, readiness, queue membership, and recoverable claims.
2. FG-591 — Kanban/CLI/API and capacity-limited compatible-work dispatch.
3. FG-593 — reconcile the Operator Work Management epic as those children land.
4. FG-498 — external issue ingestion if it remains useful after the core queue operates.

The workflow-contract idea should not become another prerequisite. It should be revisited when a concrete
workflow produces enough repeated pain to justify the platform investment.

## Questions To Revisit Later

- Can Forge enforce mutation scope generically from Git/tree evidence without embedding project-specific
  test-path conventions?
- What constitutes portable assertion-level red evidence across Node, Go, Python, and other ecosystems?
- Should detection-power mutation be mechanical, agent-driven, or both?
- How should a frozen test artifact survive request-changes, retries, fanout, and worktree publication?
- Which reviewer concerns benefit from narrow isolation, and which require an intentionally cross-cutting
  context packet?
- How can Forge measure reviewer precision and seeded-defect detection instead of treating verdict count
  as confidence?
- Can these capabilities be added as optional workflow contracts without reopening the stable core runner
  for every new workflow style?
