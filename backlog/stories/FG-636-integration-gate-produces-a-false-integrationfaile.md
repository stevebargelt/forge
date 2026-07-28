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

## What is NOT yet established

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
