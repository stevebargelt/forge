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

### Decision 5 — Reds IMPLEMENTED (2026-05-14)

When a step declares `reds: [...]`, after the primary's container produces
`result.json` successfully, the runner spawns each red as a child task
(`parentId = primaryTaskId`) in parallel via `Promise.all`. Each red runs
read-only against the primary's result as artifact. Verdicts are parsed and
written to the `verdicts` table.

**Aggregation policy** (mirrors v1 `spawnRed.ts`):
- Any red with `authority: authoritative` + `gate_on_verdict: true` returning
  `verdict: fail` ⇒ primary status `blocked_by_red`. Orchestrator surfaces.
- A red whose container crashes produces an `inconclusive` verdict; the red
  task itself is marked `failed`. ~~It doesn't block the gate.~~ **Amended by
  FG-628:** a `container_crash` means the red never reviewed the artifact at
  all, so it now blocks (`blocked_by_red`) orthogonally to authority AND to the
  step's gate — a specialist red configured `gate_on_verdict: false` blocks
  exactly as an authoritative one does, and a `gate: auto` step does not
  advance. The recorded verdict value stays `inconclusive`, with a prepended
  synthetic HIGH "never ran" finding; `oom_killed`, `idle_timeout` and
  `model_error` still ingest as non-blocking inconclusives. See "Blocked by
  red" in `docs/concepts.md`.
- Otherwise, primary status follows the step's `gate`:
  - `gate: auto` ⇒ `complete` (specialist verdicts are advisory only — recorded
    but don't block)
  - `gate: human` ⇒ `awaiting_gate`
  - `gate: verdict` ⇒ `awaiting_gate` (orchestrator reads verdicts to decide)

**State transitions:** per FORGE-DEC-017, the primary moves through
`running → awaiting_red → (awaiting_gate | blocked_by_red | complete)`.
The intermediate `awaiting_red` is set explicitly between primary completion
and red dispatch, then transitions on aggregation.

### Decision 6 — Fanout IMPLEMENTED (2026-05-14)

A step with `fanout: {...}` reads the upstream array from
`fanout.from_upstream.step`'s result at `array_key`, then spawns one child
task per element (`parentId = primaryTaskId`). Children get the per-element
value injected into `inputs` under `fanout.from_upstream.input_key`, plus
the normal upstream array.

**Concurrency**: `max_concurrency` controls batch size (default 4). The
runner processes the array in order, up to N children at a time. The "primary"
of a fanout is a synthesized parent row (no container of its own) that
aggregates child results once they all settle.

**Failure modes**:
- `fail-phase` (default): if any child in a batch fails, abort further
  batches and mark the parent `failed`. Already-launched children in the
  failing batch complete normally before short-circuit.
- `retry-once`: after the initial pass, re-dispatch any failed children
  exactly once. Replace the child outcomes with retry outcomes.
- `continue`: all children run; parent's status reflects whether ALL
  completed (per gate semantics), but partial success is preserved in the
  aggregated result.

**Edge cases**:
- Upstream array missing or empty ⇒ parent marked `failed` with explanatory
  error (the ready-queue should normally prevent this since fanout depends
  on the upstream step being complete).
- Children's results are aggregated into the parent's result as
  `{ status, children: [{ index, status, childTaskId, result }] }`.

### Decision 7 — Run terminal status ~~only `complete`, never `failed`~~ (SUPERSEDED by FG-585)

**Original decision (v2 cutover):** when all steps had task rows and no pending
work remained, runner marked the run `complete` even if some tasks failed; the
`RunStatus` union was `"active" | "complete" | "abandoned"` with no `"failed"`
state, and the human/orchestrator read task statuses to know whether the run
actually succeeded. Rationale at the time: match v1 spine behavior and avoid a
schema migration.

**Superseded by FG-585 — `failed` is now a 4th terminal run status.**
`RunStatus` is `"active" | "complete" | "failed" | "abandoned"`. A run that
settles no longer blanket-reports `complete`:
- `complete` = terminal, SUCCESSFUL — every declared step settled successfully
  (a phase that failed but has a successful replacement/recovery does not count
  against this).
- `failed` = terminal, UNSUCCESSFUL — the run settled but a required phase
  failed, OR a downstream phase became permanently unreachable because a
  dependency is terminally blocked (e.g. `verify` fails ⇒ a `docs` phase with
  `depends_on: [verify]` can never dispatch). A `run.failed` lifecycle event is
  emitted (naming the failed + unreachable phases).
- `abandoned` = operator cancel (unchanged).

**Why it fit without a migration:** `runs.status` is an unconstrained `TEXT`
column, so the new value needed no DB migration. The classification reuses the
existing evaluator rather than a new code path — the one shared
`classifyRunTerminalState` (`src/v2/ready-queue.ts`) runs over the step
settle-states already computed by `computeStepSettleStates` / `isRunSettled`,
splits the blocked steps into failed-primary vs unreachable-dependency, and
returns `failed` iff either set is non-empty. Every finalize site (gate,
runNext's wave-complete check, reconcile's active→terminal site, invoke's
closeRunIfIdle) routes through that one classifier and the shared
`finalizeRunIfSettled` helper, which does the guarded CAS and logs
`run.completed` / `run.failed`.

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
- `runNext.integration.test.ts`: 12 cases — linear two-step, human gate, manual step, parallel-within-wave (diamond), empty queue, failed step; reds all-pass, reds authoritative-fail (blocked_by_red), reds specialist-fail (advisory only); fanout success aggregation, fanout fail-phase short-circuit, fanout missing-array.
- `startRun.test.ts`: 4 cases covering input validation, designDir metadata.

All run with stubbed docker exec. No real containers spawned.

## What's NOT tested

- Real docker integration (waiting on the cutover decision)
- Fanout `retry-once` failure mode (logic implemented; needs a test pass)
- Fanout `continue` failure mode (logic implemented; needs a test pass)
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

4. **Reds + Fanout** — IMPLEMENTED. See Decisions 5 + 6 above. No longer
   blockers for cutover.

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

This works today, including reds + fanout. The same shape will work in the
wired CLI; the wrapping is the only difference.

## What this commit is NOT

- A v2 cutover. v1 spine is untouched.
- Production-ready re: real-docker integration. The exec stub model is
  tested end-to-end; the real `docker run` path is wired but not exercised
  in tests.
- The orchestrator's entry point. Orchestrator template + forge init are
  separate commits. They don't depend on this runner; they wrap the v1 CLI
  for now and will switch to the v2 CLI at cutover.

Status: 473/473 tests passing. Typecheck clean. Branch: `yaml-orchestrator-116`.
