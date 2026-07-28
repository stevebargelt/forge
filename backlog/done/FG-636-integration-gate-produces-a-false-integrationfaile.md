---
id: FG-636
type: story
status: done
title: Integration gate produces a false integration_failed on an UNMODIFIED candidate — the unit tier passes in CI and on the host at the same sha but fails inside the publication worktree
created: 2026-07-28
closed: 2026-07-28
closed_commit: d731ed5e
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
3. `src/v2/worktree-lifecycle.ts:45` — `isWorktreeModeEnabled()` returns `process.env.FORGE_WORKTREES === "1"`  *(Superseded by FG-345, 2026-07-28: isolation is default-on. The resolver is now kill-switch → explicit value → platform default (darwin on, else off), and `test-setup.ts` PINS `FORGE_WORKTREES="0"` rather than clearing it — clearing would hand the suite's outcome to `process.platform`. The mechanism FG-636 relied on is unchanged in effect: an ambient `"1"` still cannot survive preload.)*
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

## Acceptance Evidence

Shipped in `8cdb5f8f` (PR #168, merged as `d731ed5e`).

| AC | Evidence | Verdict |
|---|---|---|
| 1. Reproduce deterministically: the unit tier passes on the host and in CI at a given sha, and the same tier run by the gate against an unmodified candidate at that sha fails; capture the failing set. | Four runs in the retained failing candidate `~/.forge/worktrees/publications/f803fe43-…-r0`, clean at `de356f6a`: the 3 suspect files pass 10/10; the FULL `npm run test:unit` passes 2826/0 (launch `launch-fg636-repro-tier-ppatvs`); 5 rounds under 20-way CPU saturation pass 10/10 each (`launch-fg636-load-ki9inh`); and `FORGE_WORKTREES=1` on the same 3 files yields **9 fail / 1 pass**. The failing set is captured in the ticket's Mechanism section and matches the gate's original nine exactly, including the single passer (`fg482 single-step: CAS loses a race`). CI green at `de356f6a` = PR #167, nine checks. | met |
| 2. Identify the actual mechanism with evidence — name the file and the assumption that breaks. | `src/v2/host-readiness.ts:630` `pinnedVerificationEnv`. The broken assumption is stated in its own former doc comment: *"a verification legitimately needs the operator's environment."* True for generic env, false for forge's `FORGE_*` control switches, which reconfigure the code under test. Chain proven end-to-end: launch record `2026-07-28T01:55:35.994Z` shows the wave ran as `env FORGE_WORKTREES=1 forge next …` → `pinnedVerificationEnv` spreads it → `src/v2/worktree-lifecycle.ts:45` `isWorktreeModeEnabled()` returns true in every test child → dispatch aborts against `.git`-less mkdtemp project dirs before `writeTaskManifest` (`runNext.ts:3212`). Hypotheses 1 (location) and 2 (load/DB concurrency) each falsified by their own run above. | met |
| 3. Fix it so the gate's verdict reflects the candidate's code and nothing about where the candidate lives or what else runs on the host. | `pinnedVerificationEnv` now copies `process.env` except every `FORGE_`-prefixed key, then applies the pinned PATH — a denylist on forge's reserved namespace, not `setupEnv`'s allowlist. Covers both Forge-owned callers in one change: `src/v2/integration-gate.ts:75` and `src/v2/review-loop.ts:351`. Proven at the caller, not just the constructor: `FG-636 — runIntegrationGate passes a candidate whose suite the orchestrator's FORGE_* would have failed` and `FG-636 — review-loop verification (default runner) reaches the candidate with no FORGE_* set` (`src/v2/fg636-verification-callers.integration.test.ts`). Location and load were independently eliminated in AC 1. | met |
| 4. Add a regression that would fail if the gate's execution context could again change a test outcome. | Nine regression tests across four files. Execution-context tests: `FG-636 — a dispatch test still passes with FORGE_WORKTREES=1 in the PARENT environment` and `FG-636 — the same test passes under the env the gate actually builds from a poisoned parent` (`src/v2/fg636-gate-execution-context.integration.test.ts`). Env-shape tests: three in `src/v2/fg636-verification-env.test.ts`. **Each proven to bite** by reverting its own fix independently: reverting `host-readiness.ts` alone fails 3, reverting `test-setup.ts` alone fails 1, neither masking the other (orchestrator-run mutation test). The caller tests fail on the caller's own verdict field (`gate.ok false`), reproducing the original harm through the shipped entrypoint rather than re-asserting an env shape. | met |
| 5. If part is genuinely test-side, fix the test AND state why the gate exposed it when CI did not. | Test-side half shipped in `src/test-setup.ts`: an explicit named list clearing `FORGE_WORKTREES`, `FORGE_NO_WORKTREES`, `FORGE_WORKTREE_IGNORE_DIRTY` before any test sets a controlled value. Deliberately NOT a namespace sweep — harness inputs `FORGE_TEST_MISMATCHED_NODE` (provisioned by CI into all five `test-extended` shards, a hard requirement of `src/cli/node-preflight.integration.test.ts:287`) and `FORGE_TEST_PRINT_CMD` survive; the boundary is pinned from both sides by `FG-636 — test-setup clears the production switches and PRESERVES the harness inputs` and `FG-636 — the CI side of that contract: every integration shard still provisions the mismatched Node`. **Why the gate exposed it when CI did not:** CI runs the tier in a clean environment with no `FORGE_*` production switch set; the gate ran it with the orchestrator's inherited environment. Recorded in the ticket and in `docs/concepts.md`. | met |
| 6. `forge-test` green; required CI checks green. | `forge-test` unit tier 2829/0 and `forge-test --all` (2829 root + 138 dashboard) green in-loop; `forge-test --worktree` 401/401 — the tier most at risk from the test-setup change — and `--integration` 3983 pass / 0 fail / 1 skipped. `npm run typecheck` clean on the host at `8cdb5f8f`. Bounded review-loop `run-review-loop-fg-636-56e63f`: stop reason `passed`, `closeable: yes`, reviewer `red-wide` pass round 1, reviewed tip equal to remote head. Required CI on PR #168: `test` and `test-extended` both green at `8cdb5f8f`. | met |

**Docs impact:** updated — `docs/concepts.md` (verification-environment contract added; the prepare-or-refuse primitive points at it; the trust model's "operator's inherited environment" corrected, with an explicit statement that withholding the namespace is correctness hygiene and narrows no attack surface).
