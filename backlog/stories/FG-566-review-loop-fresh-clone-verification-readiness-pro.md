---
id: FG-566
type: story
status: active
title: "review-loop fresh-clone verification readiness: provision dependencies before round 1 and classify environment failures separately"
created: 2026-07-14
---

## Problem

`forge review-loop` can be pointed at a clean standalone clone with valid Git history but no
`node_modules` (correctly absent because dependencies are ignored by Git). When CI evidence is unavailable
and the loop falls back to local verification, it runs the discovered `npm` scripts directly in that clone.
Typecheck and test then fail before they can examine the implementation.

This happened during FG-551 under the FG-561 campaign's required standalone-clone containment. The loop
reported `verification_failed` twice and skipped the reviewer in both rounds. The orchestrator had to infer
that the clone had never been installed, distinguish infrastructure failure from code failure, select the
Node/ABI to install under, run the install, and restart the review.

That is control-plane setup work, not orchestration judgment.

Two existing contracts stop at either side of this seam:

- FG-376 provisions lockfile-keyed dependency volumes for worktree-mounted agent and reviewer containers,
  and already classifies a failed install as `verification_environment_unavailable`.
- `forge-test` maintains a writable scratch, repairs missing or incompatible dependencies, and treats an
  unrepairable scratch as infrastructure failure rather than red tests.

The host-side review-loop fallback uses neither contract. In
`src/cli/commands/review-loop.ts`, it calls `runVerification(..., { cwd: projectDir })` directly. In
`src/v2/review-loop.ts`, every failed verification is converted into fixer findings; the reviewer is
short-circuited and the failed attempt consumes a review round. A missing dependency graph is therefore
misclassified as a defect in the reviewed change.

## Goal

Before the first **local** verification attempt consumes a review round, Forge either establishes an
execution-ready verification environment or stops once with a distinct, actionable environment outcome.
The orchestrator never manually installs dependencies merely to make a Forge-owned review runnable.

CI reuse remains first-class: a clean commit with sufficient trusted CI/host evidence does not need a local
dependency installation just to begin review. Readiness is required immediately before a real local
fallback, not unconditionally before every review-loop invocation.

## Design boundaries

- Use one declared project-verification setup contract. For an npm project with a lockfile this may be
  `npm ci`; another project may supply an explicit configured bootstrap. If Forge cannot identify a safe
  setup contract, it fails before round 1 rather than guessing.
- Reuse or deliberately extend the FG-376 / `forge-test` dependency-provisioning vocabulary and failure
  classification. Do not create a third incompatible notion of dependency readiness.
- The mechanism is open: provision the standalone clone under the declared runtime, or execute local
  verification through an existing container/scratch dependency cache. The chosen mechanism must prove
  source fidelity, lockfile fidelity, runtime/ABI compatibility, and isolation from the live checkout.
- Dependency setup uses the intended verification runtime, never whichever `node` or package manager an
  ambient login shell happens to resolve. Coordinate with FG-555's launched-workload environment contract;
  do not pre-empt or contradict it.
- Never mutate the live `main` checkout, its shared native bindings, the reviewed source/lockfile, or another
  clone's dependency tree as remediation.
- Environment preparation is not a review round, reviewer verdict, or fixer attempt.

## Acceptance criteria

- Immediately before a real local verification fallback, review-loop checks whether the selected
  typecheck/test commands have an execution-ready dependency environment.
- When a supported setup contract exists, Forge provisions or repairs the environment once using the
  project lockfile and declared verification runtime. A successful preparation then starts the real review
  at round 1.
- Missing dependencies, failed dependency installation, missing package-manager/runtime, and native ABI
  incompatibility are represented as `verification_environment_unavailable` (or one explicitly equivalent
  environment disposition), never generic `verification_failed` and never a failed product test.
- An environment-unavailable outcome consumes **zero review rounds**, dispatches neither reviewer nor
  fixer, and returns one actionable recovery instruction. Re-running after repair begins at round 1.
- Deterministic verification failures produced by an execution-ready environment retain existing behavior;
  this ticket must not launder real typecheck/test failures into infrastructure outcomes.
- Durable review-loop evidence records environment preparation start/result, the setup mechanism or cache
  identity, lockfile identity, runtime/ABI identity when relevant, and whether verification used CI reuse or
  a prepared local fallback.
- Human CLI output, structured output, run notes, and dashboard surfaces distinguish environment readiness
  failure from reviewed-code verification failure. They do not say that a reviewer reviewed anything when
  verification prevented reviewer dispatch.
- Provisioning is bounded and crash-safe. A failed or interrupted install cannot be marked ready or reused
  by a later review.

## Required falsification

Each regression must be observed red against the relevant pre-fix behavior:

1. A fresh standalone clone of Forge with no `node_modules`, forced onto local fallback, currently fails
   typecheck/test, skips the reviewer, and consumes review rounds. After the fix it prepares dependencies,
   runs real verification, and dispatches the reviewer as round 1.
2. A forced dependency-install failure currently appears as ordinary verification failure. After the fix it
   stops before round 1 as `verification_environment_unavailable`, with no reviewer or fixer dispatch.
3. Dependencies absent or built for an incompatible Node ABI are not accepted as ready and cannot produce a
   wall of false product-test failures.
4. Trusted covering CI evidence still avoids unnecessary local provisioning and retains current reuse
   semantics.
5. A real typecheck/test regression in a prepared environment still follows the ordinary review-loop
   verification/fixer policy.

## Relationships and non-scope

- **FG-376:** existing container dependency provisioning and environment-failure vocabulary; reuse where
  the boundary permits.
- **FG-555:** the runtime/environment contract under which Forge-owned unattended verification and any
  dependency setup execute.
- **FG-559:** provides Git-capable linked-worktree mounts. Working Git and an execution-ready verification
  environment are distinct contracts; do not fold this ticket into FG-559.
- **FG-561:** standalone clones are currently required containment before FG-553/FG-559 land, making this
  defect repeatedly reachable during that campaign. This ticket is not a new durable-continuation slice.
- No package-manager-unification project, arbitrary shell-hook framework, review-policy redesign, or change
  to reviewer/fixer round limits.

## Size / routing note

**Medium.** This crosses review-loop verification classification, readiness/provisioning integration,
durable events/run notes, CLI/JSON/dashboard propagation, and production-path tests. It should receive a
short architecture/planning pass to choose reuse of the existing container cache versus controlled
standalone-clone provisioning, then land as one cohesive implementation if that plan remains bounded.
