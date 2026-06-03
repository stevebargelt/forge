# Agentic Workflow Next Steps

> **Roadmap largely shipped** — task contracts, project auth, provider abstraction,
> and secret hygiene have all landed. Kept as historical provenance; not a live
> operator how-to.

Forge's north star is still agent-driven work under orchestrator control: agents
think, plan, implement, test, and review; Forge owns the durable contracts,
lifecycle, evidence, and safety boundaries around that work.

The observability and lifecycle work moved Forge closer to that model. The next
steps should turn that foundation into sharper task contracts, more reliable
recovery, stronger review loops, and provider portability.

## Principles

- Keep the orchestrator in charge of routing, gates, retries, and user-facing
  decisions.
- Keep implementation agents responsible for judgment and execution, not hidden
  scripts.
- Make every task reconstructable from durable state: database rows, lifecycle
  events, logs, manifests, results, and bundles.
- Treat failures as structured signals the orchestrator can branch on.
- Make auth, secrets, browser sessions, and project files role-scoped.
- Prefer project-owned app knowledge over Forge-owned app-specific logic.
- Keep the CLI small; grow existing command surfaces before adding near-duplicate
  commands.

## Recommended Sequence

### 1. Run Lifecycle Recovery Audit

Goal: make active/running state trustworthy after host crashes, Docker races, and
interrupted Forge commands.

Scope:

- Add a reconciliation path that runs on first lifecycle-touching command
  (`status`, `show`, `next`, `continue`, `cancel`, or equivalent).
- Detect runs marked active with no live runnable work.
- Detect tasks marked running whose container is gone.
- Detect tasks whose result files exist but whose DB state was not finalized.
- Emit reconciliation events instead of silently rewriting state.
- Keep reconciliation idempotent.

Acceptance criteria:

- A simulated host crash with a running task can be reconciled into a truthful
  terminal or resumable state.
- `forge show <run-id>` explains what reconciliation changed and why.
- Re-running reconciliation does not emit duplicate terminal transitions.
- Tests cover container-gone, container-still-running, result-present, and
  active-run-with-no-work cases.

### 2. Concurrent Command Safety

Goal: prevent two Forge commands from advancing or mutating the same run in
conflicting ways.

Scope:

- Audit state transitions for `continue`/`next`, `cancel`, `retry`, `invoke
  --run`, and gate commands.
- Add lightweight run/task locking or transactional guards where needed.
- Make cancellation, retry, and continue idempotent under races.
- Ensure read-only commands (`status`, `show`, dashboard reads) tolerate
  in-progress transitions.

Acceptance criteria:

- Two simultaneous advancement commands cannot dispatch the same task twice.
- `cancel` racing with normal completion produces one coherent terminal state.
- `retry` cannot attach to stale or half-finalized task state.
- Tests exercise at least one command-race path with controlled interleaving.

### 3. Retry Semantics For Partial Failure

Goal: make retry behavior predictable after every major failure kind.

Scope:

- Define retry policy per `failure_kind`: idle timeout, container crash, auth
  failure, result missing, result malformed, gate rejected, red blocked,
  cancelled, and unknown.
- Decide what context retries inherit: upstream results, task package, auth
  profile, artifacts, previous failure summary, and logs.
- Ensure retry creates a new task identity while preserving lineage to the
  failed task.
- Prevent retries from reusing staged credential files or partial result files.

Acceptance criteria:

- `forge retry` shows why the task is retryable or not retryable.
- Retried tasks include previous failure context without leaking secrets.
- `forge show` renders retry lineage clearly.
- Tests cover retry after idle timeout, auth failure, cancelled task, malformed
  result, and gate rejection.

### 4. Task Contract Schema

Goal: give agents sharper assignments and give reviewers/orchestrators concrete
criteria to evaluate.

Scope:

- Introduce an explicit task contract object in task packages.
- Include expected artifacts, allowed file areas, acceptance checks, validation
  commands, auth requirements, risk level, and review requirements.
- Keep the contract readable in Markdown but machine-readable in the manifest or
  package metadata.
- Update the orchestrator template to prefer contracts when invoking agents.

Example fields:

```yaml
contract:
  objective: "Add cancel race tests"
  allowed_paths:
    - src/cli/commands/cancel.ts
    - src/v2/cancel.test.ts
  expected_artifacts:
    - result.json
    - tests or test updates
  validation:
    commands:
      - npm test -- src/v2/cancel.test.ts
  auth_profile: null
  risk: medium
  operator_behavior_changed: false
  review:
    required: true
    invariants:
      - "cancel remains idempotent"
      - "reds never receive auth state"
```

Acceptance criteria:

- New tasks expose their contract in `forge show`.
- Result manifests record which contract checks were satisfied.
- Agents are instructed to report deviations from the contract explicitly.
- At least one workflow and one direct `forge invoke` path use the contract.

### 5. Review Quality Protocol

Goal: make red/review agents consistently grounded, comparable, and useful.

Scope:

- Standardize review prompts around invariants, evidence, severity, and tests.
- Require file/line references for code findings.
- Require reviewers to distinguish confirmed issues from residual risks.
- Merge duplicate findings across review agents.
- Calibrate severity against exploitability, blast radius, and likelihood.

Acceptance criteria:

- Red result schema includes `finding_type`, `severity`, `confidence`,
  `evidence`, `affected_files`, and `recommended_fix`.
- The orchestrator can summarize convergent vs unique findings.
- Review agents explicitly state which invariants they verified.
- Tests or fixtures validate malformed/low-evidence review output is rejected or
  downgraded.

### 6. Project-Provided Auth State Contract

Goal: support authenticated browser work without making Forge own app-specific
credentials or login logic.

Scope:

- Define a project-level auth profile kind that runs a project command to
  produce Playwright storage state.
- Let the project own credentials, login flow, token refresh, and cleanup.
- Let Forge own role scoping, mounting, redaction, freshness checks, and
  lifecycle events.
- Keep the existing captured-session profile as a manual fallback.

Example:

```yaml
auth_profiles:
  qa:
    kind: project-command
    command: npm run e2e:auth
    storage_state: .playwright/.auth/qa.json
    required_env:
      - E2E_SUPABASE_EMAIL
      - E2E_SUPABASE_PASSWORD
    roles:
      - test-engineer
      - manual-qa
      - frontend-specialist
```

Acceptance criteria:

- Forge checks required env var names without printing values.
- Forge runs the auth command before browser-capable tasks that request the
  profile.
- Forge mounts the produced storage state read-only into the container.
- Reds do not receive auth state by default.
- `forge show` reports auth setup success/failure without exposing secrets.

### 7. Provider Runtime Abstraction

Goal: make Claude, Codex, and future agents interchangeable behind the same
Forge lifecycle.

Scope:

- Define a runtime/provider interface for prompt composition, process launch,
  streaming output, result parsing, usage/cost capture, cancellation, and error
  classification.
- Move Claude-specific assumptions behind a Claude provider.
- Add a Codex provider only after the interface is explicit enough to preserve
  lifecycle semantics.
- Keep workflow YAML and task contracts provider-neutral.

Acceptance criteria:

- Existing Claude behavior passes through the provider interface without
  behavior regression.
- Provider output streams into the same container logs and lifecycle events.
- Provider failures map into the same `failure_kind` taxonomy.
- A smoke task can run through a second provider without changing workflow
  definitions.

### 8. Artifact And Secret Hygiene Hardening

Goal: make debug artifacts useful without accidentally preserving secrets,
prompts, auth state, or project-local credentials.

Scope:

- Audit task packages, bundles, manifests, logs, dashboard payloads, and exports.
- Maintain an explicit denylist for `.env`, auth state, browser profiles,
  prompt inputs, token-looking values, and generated credential copies.
- Add positive tests for bundle contents and negative tests for excluded files.
- Clean up staged auth files after task completion where practical.

Acceptance criteria:

- `forge bundle` has tests proving auth state, `.env`, and prompt inputs are
  excluded by default.
- Staged auth files are removed or marked for cleanup after terminal task state.
- Manifest fields remain useful but never contain credential material.
- Redaction behavior is documented and visible in `forge show` or bundle
  metadata.

## Suggested First Tickets

1. Reconcile active/running state after host crash.
2. Add transaction/lock guards for continue/cancel races.
3. Define retry policy by `failure_kind`.
4. Add task contract metadata to task packages and manifests.
5. Standardize red/review result schema and severity rules.
6. Add project-command auth profile support.
7. Extract Claude execution behind a provider interface.
8. Harden bundle/log/auth-state secret exclusion tests.

These should land in this order unless a live bug forces a narrower fix. The
first three protect the lifecycle foundation; the next two improve agent output
quality; the last three broaden Forge's usefulness without weakening its
boundaries.
