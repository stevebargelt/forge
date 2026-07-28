---
id: FG-628
type: story
status: done
title: Reviewer dispatch crashes on any project directory missing a workspace-member node_modules — FG-627's mountpoint fix never covers the non-isolated path
created: 2026-07-27
closed: 2026-07-28
closed_commit: 71d7eae
---

**Found live 2026-07-27** during the FG-566 architect phase (`run-fg-566-shared-host-side-verification-readiness-contract-0f7edc`), with isolation **OFF**. Both architect reds died before starting, and their verdicts were ingested as non-blocking `inconclusive (0.00)` — so the gate opened with **no adversarial review having run at all**. Silence read as success.

## What happens

```
docker: Error response from daemon: failed to create task for container: ... runc create failed:
error mounting "/var/lib/docker/volumes/forge-deps-5f33f1ce08f5973b-dashboard/_data"
to rootfs at "/project/dashboard/node_modules":
create mountpoint for /project/dashboard/node_modules mount:
mkdirat .../project/dashboard/node_modules: read-only file system: unknown
```

Tasks: `task-red-architect-da8b83` and `task-red-architect-82a680`, both `container_crash (exit 1)`,
both at the same second they were created. The project was `~/code/forge-fg356` — an ordinary
checkout with a populated **root** `node_modules` and **no** `dashboard/node_modules`.

## Mechanism — why the primary survived and only the reds died

`src/v2/spawn.ts` mounts the dependency cache through three different branches, and only some of them
use the multi-volume plan:

- **`projectMode === "rw"` without worktree dispatch** (`spawn.ts:871`) — the architect's path. Falls
  back to a single legacy anonymous volume at `/project/node_modules`. That directory exists in any
  checkout that has ever been installed, so it always works. **The primary agent never exercises the
  multi-volume path on a non-isolated dispatch.**
- **`projectMode === "ro"` with `DEPENDENCY_CACHE_MOUNT_RO=1`** (`spawn.ts:881`) — the reviewer/red
  path. Calls `planDependencyVolumes` and mounts **every planned member volume** read-only, including
  `forge-deps-<hash>-dashboard` at `/project/dashboard/node_modules`.

`package.json` declares `workspaces: ["dashboard"]`, so the plan always contains a dashboard member.
Mounting a volume at a path inside the read-only `/project` bind requires the mountpoint directory to
**already exist in the source**; docker cannot `mkdir` on a read-only rootfs. A checkout that ran a
root-only install — or any checkout where the member was never installed — does not have it.

So the failure is reachable on a completely ordinary, non-isolated project directory, and it
selectively kills **reds and reviewers** while letting the primary through.

## Relationship to FG-627 — this is the uncovered half

FG-627 fixed exactly this docker behavior, but only at **isolated-workspace creation**:
`createDependencyMountpoints` is called from `worktree-lifecycle.ts:215` (linked worktree) and `:372`
(private clone). Neither runs when isolation is off, so a plain `--project <dir>` dispatch gets no
mountpoints created.

FG-627's premise sentence was *"A main checkout has `node_modules` physically present, so the
mountpoint exists and this works."* That is true for the **root** member and false for **every other
workspace member**. FG-627 is correctly scoped and correctly closed; this is the case its premise
excluded, measured rather than reasoned.

## Why this is more than a papercut

The reds' crash is not surfaced as a review failure. `forge show` reports:

```
Verdicts:
  - red-wide (specialist):   inconclusive (0.00) — task-red-architect-da8b83
  - red-narrow (specialist): inconclusive (0.00) — task-red-architect-82a680
```

`inconclusive` is non-blocking, so the phase advanced to `awaiting_gate` and an orchestrator that
trusted the gate would advance a phase whose adversarial review never executed. A red that could not
**start its container** is a different fact from a red that reviewed and could not decide, and the
current ingestion cannot tell them apart.

## Acceptance criteria

1. A dispatch against a project directory whose workspace member lacks `node_modules` starts its
   reviewer/red containers successfully — reproduced RED against current behavior first, using a
   checkout with a root-only install.
2. The fix covers the **non-isolated** path. Whatever creates the mountpoints must run for a plain
   `--project <dir>` dispatch, not only at isolated-workspace creation. Reuse
   `createDependencyMountpoints` rather than adding a second mechanism — it already derives its set
   from `planDependencyVolumes` so it cannot drift from what `spawn.ts` mounts.
3. The provisioner's and reviewer's project mounts stay read-only (`spawn.ts:1011`, and the `:ro`
   suffix on every planned member volume).
4. Creating mountpoints in a **live, non-disposable** checkout is safe and reversible: empty
   directories are invisible to git including `status --porcelain --ignored`, but state explicitly
   whether anything else (the FG-356 reaper's unrecovered-work probe, `npm`'s own workspace
   resolution, editor/tooling watchers) is affected by an empty member `node_modules` appearing in
   an operator's working checkout. If it is not safe there, the fix belongs at dispatch preflight
   with an explicit refusal instead.
5. **A red that never started its container must not ingest as a non-blocking `inconclusive`.**
   Container-crash-before-start is an infrastructure failure, not a review outcome; it must block the
   gate or surface distinctly enough that an orchestrator cannot mistake it for "reviewed, undecided".
   Assert both halves: the crash case blocks/surfaces, and a genuine reviewed-but-undecided verdict
   still ingests as `inconclusive` exactly as today.
6. `forge-test` green; required CI checks green.

## Immediate workaround applied

`mkdir -p ~/code/forge-fg356/dashboard/node_modules` unblocked the FG-566 run. The dependency volume
`forge-deps-5f33f1ce08f5973b-dashboard` is itself empty (0 entries), which is harmless for an
artifact-reviewing red but worth noting: the reviewer path mounts a cache that the non-isolated
primary path never populates.

Refs: FG-627 (isolated-workspace mountpoints — the covered half), FG-376 (dependency volumes,
`planDependencyVolumes`, `verification_environment_unavailable`), `src/v2/spawn.ts:845-895`,
`src/v2/dependency-provisioning.ts:167`, `src/v2/worktree-lifecycle.ts:215,372`. Red-ingestion half
is adjacent to the `runNext.ts:691` downgrade behavior already recorded for unsubstantiated fails.

## Dogfood 4 (2026-07-28) — the ticket's scope was WRONG; a third uncovered site, and it is the one that fires

Run `run-fg-628-reviewer-mountpoints-and-crashed-red-ingestion-3dc222`, dispatched
`env FORGE_WORKTREES=1 forge next …` against `/Users/stevebargelt/code/forge-fg356` at `4462a661`,
on an installed forge carrying FG-566 + FG-636. **Both architect reds crashed with the byte-identical
signature, and the phase still advanced to `awaiting_gate`.** Fourth consecutive dogfood killed here.

### What this falsifies

This ticket states the uncovered path is the **non-isolated** `--project <dir>` dispatch, and that
FG-627 covers the isolated one. **Both halves of that framing are incomplete.** This crash happened
with isolation **ON** (`FORGE_WORKTREES=1`).

The red's mounted project was neither the checkout nor a linked worktree:

```
controlPlane.projectDir = ~/.forge/worktrees/publications/e790cfb2-19a0-4f19-a0b5-93bd20cf3036-r0
controlPlane.mountMode  = ro
```

It is a **publication candidate worktree** (`createCandidateWorktree`, FG-425). Under worktree mode a
phase publishes a candidate and the reds review *that*, not the project dir. `createCandidateWorktree`
never calls `createDependencyMountpoints`. `.gitignore:1` is `node_modules/`, so a fresh candidate
checkout can never contain `dashboard/node_modules` — the hand-made workaround in `forge-fg356` is
irrelevant, because that tree is not what gets bound.

So there are **three** sites, not one: non-isolated `--project` dispatch (found first), linked
worktrees and private clones (covered by FG-627), and **publication candidates (uncovered, and the
only one that fires in the pipeline the project actually runs)**.

**Consequence for AC 2 as written:** implementing exactly "the fix covers the non-isolated path" would
have shipped, passed review, and left the pipeline just as broken. AC 2 is widened below.

### Both halves reproduced, live

- **Half A** — `docker: ... error mounting ".../forge-deps-5f33f1ce08f5973b-dashboard/_data" to rootfs
  at "/project/dashboard/node_modules": create mountpoint ...: read-only file system`, on
  `task-red-architect-94c56b` and `task-red-architect-58946b`, both `container_crash (exit 1)`.
- **Half B** — both ingested as `inconclusive (0.00)` (`forge show task-architect-d69998`), the phase
  reached `awaiting_gate`, and **the architect gate opened with zero adversarial review having run.**

### Chicken-and-egg (why the pipeline is not the vehicle for this ticket)

Every phase publishes a candidate and every phase's reds review it, so *every* red in a worktree-mode
pipeline hits this. FG-628 cannot be implemented *through* the pipeline, because FG-628's own defect
prevents the pipeline from reviewing anything. This ticket is implemented via the invoke chain and the
pipeline is re-dogfooded afterwards to confirm reds start.

### AC 2 — WIDENED (supersedes the original wording)

The fix must cover **every tree that can be bound at the container's project path**, not an enumerated
list of paths. Establish the mountpoint precondition against `repoRootForMount` at the point the
read-only mount is decided, so isolated constructors (`worktree-lifecycle.ts:215`, `:372`) become two
callers of one mechanism rather than the only ones, and publication candidates are covered by
construction. Still `createDependencyMountpoints`, still no second mechanism.

### Architect findings worth keeping (task `task-architect-d69998`, this run)

1. **AC 4 fork — RESOLVED: create the mountpoints; do NOT take the preflight-refusal branch.** Four
   empirical probes came back negative. The FG-356 reaper cannot see them (its probe is
   `git status --porcelain --ignored` against the *task workspace* from the DB row, and a non-isolated
   dispatch has no task workspace at all); git ignores empty ignored dirs across `status`/`ls-files`/
   `clean` variants, verified in a purpose-built fixture. Refusing instead would convert a crash into a
   permanent refusal for every project that ever ran a root-only install — strictly worse.
2. **HIGH risk on Half B: do not implement it by extending FG-586's `resultUnreadable` channel.** That
   channel blocks only when `authority === "authoritative" && gate_on_verdict`
   (`runNext.ts:1382-1394`, `gate.ts:60-66`), and both crashed reds were **specialist**. An engineer
   using FG-586 as the template ships a change that passes review and still lets this exact gate open.
   Container-crash-before-start must be **orthogonal to authority**: authority weights an *opinion*, and
   a container that never started produced none. A missing panel member makes the panel incomplete
   regardless of rank.
3. **HIGH risk: the crash/undecided distinction is destroyed one call before the seam that needs it.**
   `runContainer`'s container-crash branch (`runNext.ts:3554`) is the only one of its three `failed`
   returns that does not thread `failureKind` back to the caller — the malformed (`:3572`) and
   missing-result (`:3638`) branches both do, and the result type already permits it (`:2914`). At
   `runOneRed` (`:1596-1618`) a `container_crash` is therefore indistinguishable from any other
   dispatch failure. Thread it before trying to gate on it.
4. **Constraint: do not "correct" the readiness/mountability key asymmetry.** The container cache key is
   ABI-free by design and host-global, so a `.ready` marker legitimately spans checkouts; what must
   become checkout-scoped is the **mountpoint precondition**, not the readiness key. Making readiness
   per-checkout collides head-on with FG-566.
5. **Constraint: no host-side mutual exclusion on a non-isolated project dir** — the only dispatch lock
   is per-run, and a fanout wave dispatches children in parallel. Anything written into the operator's
   tree at dispatch must be idempotent under concurrency.

## AC 5 — WIDENED (operator decision 2026-07-28; supersedes the "pre-start crash" wording)

The review-loop drove the original wording into a dead end: narrowing the channel to a proven pre-start
crash made it depend on `containerStarted`, which is unreliable — in attached mode
(`FORGE_DETACHED_EXEC=off`) `defaultDockerExec` signals the start immediately after spawning the docker
*client*, before docker creates the container, so a mountpoint failure reported `containerStarted=true`
and the original bug survived, fail-open.

**The invariant is defined by the REVIEW ARTIFACT, not by container lifecycle.**

1. **Every dispatched panel slot must produce a valid review verdict.** A slot that does not means the
   panel is incomplete.
2. **A genuine reviewer-authored `inconclusive` remains a review** and keeps its existing semantics
   (non-blocking for a non-authoritative red). The reviewer looked and could not decide — that is an
   opinion.
3. **A SYNTHESIZED `inconclusive` — one forge fabricates because no valid review came back — means the
   panel is incomplete and MUST BLOCK, orthogonally to authority.** Causes include, and are not limited
   to: pre-container crash, attached-mode docker startup failure, post-start crash with no result,
   idle timeout, OOM, missing result, malformed result.
4. **Container lifecycle signals are DIAGNOSTIC ONLY.** They belong in the event payload for an
   operator to read. They must never determine gate completeness.

Keying on provenance rather than on an enumerated list of failure kinds is the durable property: a
failure mode nobody has enumerated yet still fails closed, because the question asked is "did a reviewer
author this verdict?" and not "which way did it die?".

**Event renamed.** `verdict.review_never_ran` is inaccurate when a reviewer started and crashed midway.
Use `verdict.review_missing`, carrying the failure kind (and any container-lifecycle diagnostics) in its
payload.

**Careful boundary — do not over-widen.** `runNext.ts`'s AWN-5 downgrade of an unsubstantiated `fail` to
`inconclusive` is NOT a synthesized-missing verdict: the reviewer produced an artifact and forge
downgraded it after grading rejected its findings. That is reviewer-authored and keeps its current
non-blocking behavior. The distinction is exactly rule 2 versus rule 3.

**Consequence for FG-586.** Its authority-gated `resultUnreadable` block becomes a strict subset of this
rule — `result_missing` / `result_malformed` are synthesized verdicts and now block for every authority,
not only for an authoritative `gate_on_verdict` red. FG-586's distinctive finding text is retained for
the authoritative case; the BLOCK itself now comes from the general rule.

### Required coverage

- pre-container crash;
- attached-mode docker startup failure (the mode that defeated the narrowing);
- post-start crash with no result;
- genuine reviewer-authored `inconclusive` — still non-blocking, the regression guard that keeps this
  from becoming "any red failure blocks";
- the AWN-5 downgraded-`fail` path — still non-blocking.

## Acceptance Evidence

Shipped across 14 commits on `fg-628-reviewer-mountpoints` (PR #169, merged as `71d7eae`).
**AC 2 and AC 5 are the WIDENED wordings** recorded in "Dogfood 4" and "AC 5 — WIDENED"; the originals
were falsified during implementation and both amendments are recorded above with their reasoning.

| AC | Evidence | Verdict |
|---|---|---|
| 1. A dispatch against a project dir whose workspace member lacks `node_modules` starts its reviewer/red containers successfully — **reproduced RED first**, using a checkout with a root-only install. | RED demonstrated twice. **Live:** run `run-fg-628-…-3dc222` under `FORGE_WORKTREES=1` crashed `task-red-architect-94c56b` and `-58946b`, both `container_crash (exit 1)`, with the `create mountpoint … read-only file system` signature. **Differential:** stashing only `src/v2/runNext.ts`, A1/A2/A3 + B1 FAIL and B2/B3 PASS; with the fix all pass. **The OUTCOME (a container actually starting) is proven by `FG-628 (A4)` against a REAL docker daemon** — the nested read-only bind fails without the mountpoint and starts with it. The stubbed A1–A3 establish the precondition only; the reviewer was right that they could not reach AC 1's outcome, and A4 exists because of that finding. | met |
| 2. The fix covers every tree that can be bound at the container's project path (**widened**); reuse `createDependencyMountpoints`, no second mechanism, no drift. | Precondition established against `repoRootForMount` at the point the read-only mount is decided, so FG-425 publication candidates — the site that actually fired — are covered by construction rather than enumeration; `worktree-lifecycle.ts:215`/`:372` remain two callers of one mechanism. No-drift asserted structurally: `FG-628 (D1)` adds a workspace member and requires both `planDependencyVolumes` and the created set to move together; `(D2)` requires the created mountpoints to equal exactly the volumes `spawn.ts` binds. Mutation M8 (hardcoding the member list) kills both. | met |
| 3. The provisioner's and reviewer's project mounts stay read-only. | Asserted inside the A-tests, each with a non-vacuity check that the member volume genuinely appears in the container argv — without it "the mountpoint exists" would pass against a dispatch that mounts nothing. | met |
| 4. Creating mountpoints in a live, non-disposable checkout is safe and reversible, **and it is explicitly stated** what else is affected — or the fix belongs at preflight with a refusal. | Fork resolved to **create, not refuse** (refusing would convert a crash into a permanent refusal for every project that ever ran a root-only install). Safety asserted empirically, not argued: `FG-628 (A2)` compares `status --porcelain`, `status --porcelain --ignored` and `ls-files --others` against their **pre-dispatch** output. Non-destructive: `(D3)`, killed by mutation M9 (`rmSync` before `mkdirSync`). Idempotent under concurrency: `(A3)`. **Containment:** `(A6)` a member symlinked out of the checkout creates NOTHING outside it, `(A6b)` the escape degrades the dispatch rather than crashing — a review finding, since the original code followed the symlink and `mkdir`'d outside the tree, which broke this AC's own basis. **Fail-safe:** `(A5)` an unwritable checkout records `dependency_mountpoints_unavailable` and mounts NO dependency volume. **Stated** as required: `docs/concepts.md` carries an explicit operator-visible side-effect paragraph — including the corrected fact that `git clean -fdX` **can** remove these directories (harmless: the next dispatch recreates them). The earlier "invisible to git" phrasing was too strong and is fixed. | met |
| 5. A dispatched red that produced no valid review must not ingest as a non-blocking `inconclusive`; assert BOTH directions (**widened** — keyed on the review artifact, not the container lifecycle). | **Blocks:** `(B1)` pre-container crash, `(B5)` container started then crashed with no result, `(B6)` attached-mode docker startup failure *while `container.started` was already signalled* — the exact fail-open a narrower rule produced, `(C5)` `oom_killed`, `(C6)` `idle_timeout`, `(C7)` `model_error`, `(C9)` specialist post-start crash, `(C2)` specialist unreadable result. Every blocking assertion is made against a **specialist** red with `gate_on_verdict: false`, so a fix routed through authority fails them. **Does not block:** `(B2)` reviewer-authored `inconclusive`, `(B3)` reviewer passed, `(B7)` AWN-5's downgraded unsubstantiated `fail`. **Non-regression:** `(C1)` FG-586 authoritative unreadable still fails closed, `(C3)` FG-420 shipping-reviewer, `(C4)` FG-420's finding stays at `findings[0]` when both fire. **Atomicity:** `(B4)` a failed verdict insert leaves no `verdict.review_missing` event behind — the event and the block roll back together, restoring FG-482's invariant. **Operator surface:** `(B8)` `forge show` renders the distinction in human and `--json`; `(B9)` a reviewer-authored inconclusive carries neither marker. | met |
| 6. `forge-test` green; required CI checks green. | Unit tier 2829/2829. Worktree tier green (the single macOS-only failure is pre-existing **FG-556**, `/var` vs `/private/var`, proved pre-existing by differential and green in Linux CI). Integration tier green on a clean tree — the 39 failures seen with a dirty tree are `assertBuilderCheckoutIsCommitted` refusing to build a release from uncommitted work, verified by stash-differential three separate times and independently corroborated by the orchestrator's own 36/36 clean run of that suite. Required CI on PR #169: `test` and `test-extended` both green at the reviewed tip `2a6b9271`. | met |

### Honest limits — recorded, not waived

- **Linux CI does not exercise the mount.** The dependency-cache mechanism is `process.platform === "darwin"`-gated, so a green CI run is not evidence for Half A's mount. `(A4)` is the daemon-level proof and it ran on the macOS host.
- **`(A4)` skips without a reachable probe image.** It defaults to `busybox:latest`; this host cannot pull from the registry, so it was run with `FORGE_TEST_DOCKER_PROBE_IMAGE=ubuntu:22.04`. A machine with a daemon but no probe image gets a loud skip, not a pass — but it is a skip, so `(A4)` is not self-certifying on an arbitrary host.
- **Fan-out composition is untested end to end.** The decision logic is shared (`dispatchReds` → `redRejection`) and the transition mechanics are covered by FG-482's fan-out cases, so the path is correct by construction — but the composition has no test. Deferred deliberately to a filed follow-up rather than closed over.

**Docs impact:** updated — `docs/concepts.md` (Gate, Verdict, Blocked by red as four conditions with the
provenance rule, the mountpoint precondition, the operator-visible live-checkout write, the two new
timeline events, the non-fatal unavailable posture), `docs/how-to-new-feature.md`,
`docs/how-to-set-up-notifications.md`, `seeds/workflows/feature.yml` and `security-audit.yml` (comments
only — no values changed), `src/v2/DECISIONS.md`, and the orchestrator template plus its rendered
`CLAUDE.md` block, kept in parity by `orchestrator-block-parity.test.ts`.
