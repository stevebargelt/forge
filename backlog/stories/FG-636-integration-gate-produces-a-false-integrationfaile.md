---
id: FG-636
type: story
status: active
title: Integration gate produces a false integration_failed on an UNMODIFIED candidate — the unit tier passes in CI and on the host at the same sha but fails inside the publication worktree
created: 2026-07-28
---

**Found 2026-07-28** by the FG-621 AC 11 dogfood (`run-fg-628-…-dogfood-3-8a668c`), immediately after
FG-566's readiness contract started working. This is NOT the FG-566 defect — readiness succeeded, the
native binding loaded, and the gate correctly classified test failures as a code verdict. The problem
is that **the test failures themselves are false**.

## The discrepancy

The same commit, three environments, two answers:

| Where | Result |
|---|---|
| CI at `de356f6a` (PR #167, all nine checks) | **green** |
| Host, `npm run test:unit` in the clone at `de356f6a` (clean tree, pinned control runtime) | **green**, exit 0 |
| Integration gate, same sha, inside the publication candidate | **9 failures** → `integration_failed` |

The candidate under gate was the ARCHITECT phase's output — an artifact and **no code change**. So the
gate returned a code verdict on a tree that is, for testing purposes, unmodified `de356f6a`.

## The nine

Three files, nine distinct tests:

- `src/v2/fg366-runtime-name-resolved.test.ts` — "sentinel 'claude' runtime records the concrete
  declared name on the runNext/pipeline path"
- `src/v2/fg482-*` (blocked_by_red CAS) — five tests covering the single-step and fanout happy paths,
  the forced-event-failure rollbacks, and the CAS-loses-a-race case
- `src/v2/runNext-spec.test.ts` — the three FG-270 `renderTaskPackage` / `buildRedSpec` cases

They share a shape: they exercise seed generations, runtime resolution, and task-package rendering —
all of which read or publish under `FORGE_HOME`.

## What is NOT yet established (ANSWERED 2026-07-28 — hypothesis 3 confirmed; see Mechanism below)

The mechanism. Do not assume it; the obvious hypotheses are each cheap to test and each would imply a
different fix:

1. **CWD inside the real `FORGE_HOME`.** The candidate lives at
   `~/.forge/worktrees/publications/<attemptId>-r0`, i.e. *underneath* the real forge home. Code or
   tests that resolve forge home, or that ask "is this path inside FORGE_HOME", may answer
   differently when the process CWD is itself inside it. `fg366` calls
   `publishFlatAsGeneration(process.env.FORGE_HOME!)` and reads a runtime back.
2. **Concurrency with the live host.** The gate runs while the orchestrator and other launches are
   using the real `~/.forge/forge.db`. If any of these tests is not fully `FORGE_HOME`-isolated, a
   concurrent writer changes the answer.
3. **Environment shape.** The gate now runs under the pinned control-runtime PATH and a constructed
   env. The host diagnostic also ran pinned, which weakens this one — but the gate's env is
   constructed rather than inherited, so it is not identical.

## Why it matters

A false `integration_failed` blocks publication and is recorded as a verdict on the reviewed code.
That is the same class of harm FG-566 was written to eliminate, arriving through a different door:
FG-566 stopped environment faults during *preparation* from being reported as code defects; this is an
environment artifact during *verification* doing exactly that. An operator or orchestrator reading the
run sees "the change failed the gate" when the change was not even present.

It also makes the gate untrustworthy in the direction that matters most — it fails closed on good
work, so the cost is silent lost throughput rather than a bad merge.

## Acceptance criteria

1. Reproduce deterministically: the unit tier passes on the host and in CI at a given sha, and the
   same tier run by the integration gate against an unmodified candidate at that sha fails. Capture
   the failing set.
2. Identify the actual mechanism with evidence — not a plausible story. Name the file and the
   assumption that breaks.
3. Fix it so the gate's verdict reflects the candidate's code and nothing about where the candidate
   happens to live or what else is running on the host.
4. Add a regression that would fail if the gate's execution context could again change a test outcome
   — e.g. running the tier from a path under `FORGE_HOME`, or with a concurrent writer on the real DB,
   depending on which mechanism proves out.
5. If part of this is genuinely test-side (a test that is not `FORGE_HOME`-isolated and should be),
   fix the test AND state why the gate exposed it when CI did not.
6. `forge-test` green; required CI checks green.

## Non-scope

Not a change to FG-566's readiness contract, which worked. Not a change to the gate's
three-way classification (FG-424), which also behaved correctly given the inputs it had.

Refs: FG-566 (readiness — the reason this became visible), FG-357/FG-425 (the gate and serialized
publisher), FG-424 (gate failure classification), `~/.forge/worktrees/publications/<attemptId>-r0` as
the candidate location. Evidence run: `run-fg-628-…-dogfood-3-8a668c`, task `task-architect-2b12d8`.

## Mechanism — ESTABLISHED 2026-07-28

**The gate inherits the orchestrator's `FORGE_*` control-plane switches into the candidate's own test
suite.** `src/v2/host-readiness.ts:630`:

```ts
export function pinnedVerificationEnv(label: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: controlRuntimeProfile({ label: `host-verification:${label}` }).path };
}
```

Its doc comment names the assumption that breaks: *"Unlike setupEnv this inherits process.env: a
verification legitimately needs the operator's environment (it is running the operator's own test
suite)."* True for generic environment; **false for forge's own control switches**, which reconfigure
the very code under test. The sibling `setupEnv` (same file, line 611) already withholds everything
outside an explicit `SETUP_ENV_PASSTHROUGH` allowlist — the correct pattern was ten lines above the bug.

The chain for this run:

1. The dogfood's wave was launched as `env FORGE_WORKTREES=1 forge next run-fg-628-…` (launch record,
   `2026-07-28T01:55:35.994Z`), so the switch was live in the forge process env.
2. `pinnedVerificationEnv` spread it into the `npm run test:unit` child.
3. `src/v2/worktree-lifecycle.ts:45` — `isWorktreeModeEnabled()` returns `process.env.FORGE_WORKTREES === "1"`
   — so **worktree mode was ON for every unit-test child process**.
4. The affected tests dispatch against `mkdtemp` project dirs with no `.git`, so worktree creation
   fails and dispatch aborts before writing the task manifest: fg366 reads a manifest that was never
   written (ENOENT), fg482's task lands `failed` instead of `blocked_by_red`, and the fanout parent /
   red-wide tasks are never created at all.

### Evidence — four runs, one variable

All four in the retained failing candidate
`~/.forge/worktrees/publications/f803fe43-1697-42b4-8abd-aa0749fcab99-r0`, clean at `de356f6a`:

| Run | Result |
|---|---|
| The 3 suspect files, in the exact failing directory | 10/10 pass |
| **Full `npm run test:unit`** in that same directory | **2826 pass, 0 fail** |
| 3 files x 5 rounds under 20-way CPU saturation | 10/10 pass every round |
| 3 files with **`FORGE_WORKTREES=1`** | **9 fail / 1 pass — the identical nine, same single passer** |

This eliminates hypothesis 1 (CWD inside `FORGE_HOME`) and hypothesis 2 (load / concurrency with the
live DB), and confirms hypothesis 3 (environment shape) with a deterministic single-command
reproduction. The one test that passes under the repro — `fg482 single-step: CAS loses a race` — is
the same one that passed in the gate, so the match is exact rather than approximate.

### Both callers are affected

`pinnedVerificationEnv` has two callers, and the ticket's framing understates the blast radius:

- `src/v2/integration-gate.ts:75` — the post-merge integration gate (the observed failure).
- `src/v2/review-loop.ts:351` — **review-loop host verification**. Since FG-474 its result is recorded
  as a `host_verifications` row and reused as covering evidence, so a false verdict here is persisted
  as audit evidence rather than merely blocking one publication.

32 distinct `FORGE_*` switches can currently reach a candidate's suite by this route.

## Fix scope (operator-approved 2026-07-28)

1. **Gate-side (primary).** `pinnedVerificationEnv` removes the entire Forge-reserved `FORGE_*`
   namespace from the candidate verification environment, then applies the pinned PATH. A denylist on
   forge's own namespace rather than a full allowlist: it kills exactly the leak while preserving the
   documented intent of inheriting the operator's general environment, and cannot break an arbitrary
   project's suite. Fixes both callers at once.
2. **Test-side (defense in depth, AC 5).** `src/test-setup.ts` explicitly clears the ambient
   *production behavior switches* that affect suite-wide behavior — at minimum `FORGE_WORKTREES`,
   `FORGE_NO_WORKTREES`, `FORGE_WORKTREE_IGNORE_DIRTY` — before tests set their own controlled values.
   Verified safe: the worktree tier sets `process.env.FORGE_WORKTREES = "1"` inside the tests
   themselves and does not depend on an ambient value.
   **NOT a blanket namespace deletion.** Test-harness inputs must be preserved — `FORGE_TEST_MISMATCHED_NODE`
   is injected deliberately by CI into all five `test-extended` shards (`.github/workflows/ci.yml`) and is
   a HARD requirement of `src/cli/node-preflight.integration.test.ts:287`; clearing it would erase a valid
   harness input and break `test-extended`. `FORGE_TEST_PRINT_CMD` is the other harness variable.
3. **Regressions (AC 4).** (a) an environment-shape unit test asserting `pinnedVerificationEnv()` drops
   `FORGE_*` while keeping the pinned PATH; (b) an execution test that runs a representative dispatch
   test with `FORGE_WORKTREES=1` set in the PARENT env and asserts it still passes — i.e. the gate's
   execution context cannot change a test outcome.

**Why the gate exposed this when CI did not:** CI runs the tier in a clean environment with no
`FORGE_*` production switch set; the gate ran it with the orchestrator's inherited environment.

**Known interaction (no action):** `FORGE_TEST_MISMATCHED_NODE` is itself `FORGE_*`, so the gate-side
strip withholds it from verification as well. That is a no-op today — it is unset in the orchestrator
environment, and `node-preflight.integration.test.ts` falls back to scanning installed interpreters —
but it is recorded here in case a future host relies on it for extended verification.
