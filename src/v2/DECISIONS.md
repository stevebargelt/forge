# forge v2 runner — decisions taken during the first-pass build

Written 2026-05-13 overnight while Steven slept. Calls I made unilaterally that
you may want to revisit before cutover. Each one is reversible — the runner is
not wired to CLI yet.

## Architecture

### Decision 1 — Shape A (wave-per-call), not Shape B (long-lived loop)

`runNext` dispatches **one wave** of ready steps and returns. The orchestrator
calls it in a loop. There is no long-lived runner process.

**Why:** matches forge's existing model (every `forge next` invocation is a
fresh Node process). Composes with the dashboard's "Run Next" button and the
orchestrator's "call between gate decisions" pattern. Less in-memory state;
everything lives in SQLite.

**Alternative I rejected:** Jeff/Terry's long-lived `--watch` loop. Would have
required a daemon-shaped process, polling between gate-wait, doesn't compose
with the dashboard's event model.

**If you flip it:** the dispatch logic is reusable; you'd add a wrapper that
calls runNext in a loop with sleep between, exiting on gate or completion.
~30 LoC wrapper.

### Decision 2 — Gate hand-off: runner doesn't call gate.ts inline

When a step completes with `gate: human` or hits `gate: verdict`, the runner
writes `awaiting_gate` to SQLite and returns. **It never imports or calls
`gate.ts`.** The dashboard / orchestrator / CLI call gate.ts when humans act;
gate.ts writes the next round of pending tasks; the next `runNext` picks them up.

**Why:** clean separation of concerns. Runner reads workflow + tasks, dispatches.
Gate code reads verdicts + rationale, writes new tasks. Both write SQLite; they
don't call each other. Easier to test runner in isolation.

**Alternative I rejected:** runner calls `gate.evaluate(task.id)` inline after
each step. Tighter coupling, more code to keep in sync.

### Decision 3 — `depends_on` semantics: all-must-be-complete

A step is ready when ALL its `depends_on` ancestors have a primary task in
status `complete`. No "any-of" semantics. No depth limits (transitive
satisfaction is implicit via the graph).

**Why:** matches Jeff/Terry's DAG model. Matches today's spine "previous
phase complete" check. Predictable. Easy to reason about.

**If you ever want "any-of":** add a new field like `depends_on_any: [...]`.
Schema change, not a runner change.

### Decision 4 — Ready-queue treats `pending` as "ready to dispatch"

If a step has any task in `pending` status, the runner picks it up next wave.
This handles the gate.ts request-changes pattern: gate.ts inserts a fresh
`pending` task for the same step; runner sees it and re-dispatches.

**Why:** lets the gate's existing semantics work unchanged. No new "needs
redispatch" status required.

**Alternative I rejected:** a separate "pending" → "queued" → "running"
transition. Three states instead of two; more state machine to maintain.

### Decision 5 — Reds NOT IMPLEMENTED yet in this first pass

When a step declares `reds: [...]`, the runner marks the primary task
`awaiting_gate` after the primary completes — but does NOT spawn reds.

**Why:** scope. Reds dispatch is its own architectural decision (timeout
semantics, what "awaiting_red" status really means in v2, how verdicts
aggregate). Wanted to ship the topology + dispatch core first; reds are
additive.

**What's missing:**
- Spawning red containers in parallel after primary completes
- Writing verdict rows
- Aggregating verdicts for `gate: verdict` decisions
- Status transitions `awaiting_red` / `blocked_by_red`

**How to add:** after `dispatchStep` reads `result.json` successfully, before
the gate-decision switch, iterate `step.reds` and Promise.all spawn each as
a child task with `parentId = primaryTaskId`. Each red's result is a Verdict;
write to verdicts table via `insertVerdict`. Then evaluate aggregate and set
the primary's status to `awaiting_gate` (verdict mode) or `blocked_by_red`
(if authoritative fail). Roughly 60-80 LoC.

### Decision 6 — Fanout NOT IMPLEMENTED yet in this first pass

A step with `fanout: {...}` is treated by the runner like a normal step
right now (single dispatch). The fanout block in YAML is parsed but ignored
at dispatch time.

**Why:** same as reds — scope. Fanout's failure_mode policies (`fail-phase` /
`retry-once` / `continue`) have non-trivial semantics. The investigation /
codebase-assessment workflows DO use fanout today via the v1 spine, so this
is a real gap before v2 cutover.

**How to add:** before `dispatchStep`'s main logic, check `step.fanout`. If
set, read the upstream array (per `fanout.from_upstream`), generate one task
per array element with synthetic step ids (`<stepId>-<index>`), apply
`max_concurrency` via a semaphore around `Promise.all`. Apply `failure_mode`
after all children complete. Roughly 100-150 LoC.

### Decision 7 — Run terminal status: only `complete`, never `failed`

When all steps have task rows and no pending work remains, runner marks the
run `complete`. Even if some tasks failed. The human/orchestrator reads task
statuses to know whether the run succeeded.

**Why:** v1's `RunStatus` union is `"active" | "complete" | "abandoned"` —
there's no `"failed"` state. Matches v1 spine's behavior. Adding a `"failed"`
run status would be a schema migration.

**If you want a `failed` run status:** add to the RunStatus union in types,
migrate the DB, update reconcile.ts. Not in scope for v2 cutover.

### Decision 8 — Direct depends_on for inputs.upstream[*]

`deriveUpstream` walks ONLY direct depends_on ancestors, not transitive.
A build step depending on a plan step sees the plan's output as upstream;
it does NOT see the architect's output (which the plan depends on).

**Why:** matches today's spine "previous phase only" semantics. Encapsulation:
plan's job is to forward what's worth forwarding from architect.

**If you want transitive:** add a `transitive: true` opt-in field on the step
or change the default. Schema change.

### Decision 9 — Container exec: injectable for testing, real docker by default

`runNext` accepts an optional `dockerExec` function. Tests pass a stub that
writes result.json directly. Real callers leave it undefined and the default
implementation invokes `docker run ...` via child_process.

**Why:** enables real integration tests without docker, which is essential
for CI and overnight work. The contract is small (args, stdin, stdoutPath,
stderrPath → exit code).

**Where it falls short:** no idle-watchdog yet. Today's spine has a watchdog
that kills containers with no stdout for 5 min. The runner's exec stub
doesn't implement it. To add: copy the pattern from src/spine/spawn.ts's
runDocker function. ~50 LoC.

## What's tested

- `ready-queue.test.ts`: 8 cases covering linear, parallel, diamond, retry-pending, dep-not-met.
- `inputs.test.ts`: 7 cases covering empty deps, multi-dep, latest-primary, child task filtering, missing/malformed result.json.
- `runNext.test.ts`: 6 cases covering linear two-step, human gate, manual step, parallel-within-wave (diamond), empty queue, failed step.
- `startRun.test.ts`: 4 cases covering input validation, designDir metadata.

All run with stubbed docker exec. No real containers spawned.

## What's NOT tested

- Real docker integration (waiting on the cutover decision)
- Reds (not implemented)
- Fanout (not implemented)
- Reconcile interaction (the runner doesn't call reconcile; if reconcile runs
  concurrently, behavior is undefined — needs a real test pass)
- gate.ts interaction (deliberate; runner doesn't call it)

## Open questions for cutover

1. **CLI wiring.** Where does `forge next` route? Add a `--v2` flag? Detect
   workflow YAML vs. TS and route automatically? Pure v2-only after cutover?
   Lean: pure v2-only at cutover (delete v1 spine + v1 next.ts), but a brief
   coexistence period with `--v2` flag might be safer for the first agent run.

2. **Reconcile compatibility.** Today's reconcile.ts reads tasks.taskPackage
   JSON, container.stdout.log, result.json from disk. Runner writes the same
   shapes. Should work unchanged. Real test: run reconcile against a run
   created with runNext, see if it does the right thing on orphans.

3. **gate.ts compatibility.** Today's gate.ts writes new pending tasks for
   `request-changes`, advances by writing new tasks for the next phase,
   rejects via `onReject` (phase name in v1, step id in v2 — same thing).
   v2's `step.on_reject: <step-id>` field needs gate.ts updated to read it.
   Roughly 10 LoC change.

4. **Reds + Fanout.** Mark these blockers for v2 cutover. The investigation
   and codebase-assessment workflows DO use fanout in production. Cutting
   over without fanout would break those two workflows.

5. **The orphan-warning in install-seeds.sh.** Triggers on every install when
   pre-rename agent dirs exist. After Steven runs cleanup once, this stops
   firing. Not load-bearing; remove from install-seeds.sh after cutover.

## What this commit IS

Working, tested runner core. Can be imported as a library and called from a
script:

```typescript
import { startRun } from "./v2/startRun.js";
import { runNext } from "./v2/runNext.js";
import { loadWorkflow } from "./v2/loader.js";

const workflow = loadWorkflow("feature");
const { runId } = startRun({
  workflow,
  title: "phase-flow pill row",
  inputs: { brief: "..." },
  projectDir: "/Users/steven.bargelt/code/forge",
});
while (true) {
  const wave = await runNext({ runId, workflow });
  if (wave.dispatchedSteps.length === 0) break; // gated or done
}
```

This works today (with reds and fanout disabled). The same shape will work in
the wired CLI; the wrapping is the only difference.

## What this commit is NOT

- A v2 cutover. v1 spine is untouched.
- Production-ready. Reds + fanout missing. No real-docker integration test.
- The orchestrator's entry point. Orchestrator template + forge init are
  separate commits. They don't depend on this runner; they wrap the v1 CLI
  for now and will switch to the v2 CLI at cutover.

Status: 456/456 tests passing. Typecheck clean. Branch: `yaml-orchestrator-116`.
