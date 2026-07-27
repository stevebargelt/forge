---
id: FG-625
type: story
status: active
title: review-loop fix rounds stop verification_failed and leave fixes uncommitted without naming the failed check or output
created: 2026-07-25
---

## Problem

`forge review-loop` has twice produced a correct fixer diff, then stopped
`verification_failed` and left the diff uncommitted. The durable report says only:

```
fix left uncommitted (verification failed): <paths>
```

It does not name the failing verification step, command, tier, exit status, or output. The actual
cause of the two observed failures is therefore **unknown**.

The initial diagnosis blamed the release integration tests' clean-builder precondition. That was an
inference from the fixer's separate `forge-test --integration` run, not evidence from review-loop's
own failing verifier. The ticket must not turn that inference into an implementation direction.

## Two verification paths — do not conflate them

`buildReviewLoopDeps` has two distinct local-verification paths:

1. **Round-entry verification** — `verifyWithReuse()` in
   `src/cli/commands/review-loop.ts`. It checks tree state first. A dirty tree runs
   `scriptsForVerification()`, which retains `test:extended` whenever the derived required-gate list
   has more than one entry. Measured for this project on 2026-07-25:

   ```
   requiredHostGate = "npm run test:all"
   deriveRequiredGateList(...) = ["npm run test:all", "npm run test:extended"]
   extendedIsRequired = true
   ```

   Therefore a dirty tree runs the extended tier by default; `--local-extended` is not required.

2. **Post-fixer, pre-commit verification** — `fix()` after its scope-guard reverts. It calls
   `runVerify(localFallbackScripts())`. That is the fast tier (`typecheck` + `test`) unless
   `--local-extended` was explicitly requested. If this verification fails, `fix()` returns only
   `{ verificationFailed: true, dirtyPaths }`; it discards `verification.steps`, including every
   failed step's output.

The operator message `fix left uncommitted (verification failed)` comes from path 2. On the resulting
FG-559 tree, the two path-2 commands were rerun directly:

```
npm run --silent typecheck  # exit 0
npm run --silent test       # exit 0, 2785/2785
```

Those later passes do not prove what happened during review-loop. They prove only that the previously
asserted release-tier mechanism does not explain the recorded path-2 stop.

## Evidence

Observed on two clean-start FG-559 runs:

- `run-review-loop-fg-559-fdc4ce` — reviewer found the missing reconcile classification; the correct
  fix was committed by hand as `aba8d32`.
- `run-review-loop-fg-559-632048` — reviewer found the `FORGE_SKIP_GIT_PROBE` bypass; the correct fix
  was committed by hand as `7ef7141`.

Both runs began at SHAs with all required CI checks green. In both, the fixer completed and left a
concrete in-scope diff. In both, review-loop stopped `verification_failed`, reported only the dirty
paths, and supplied no failed-step evidence. The five FG-559 review fixes ultimately required five
hand commits; this missing evidence made the first two failures impossible to diagnose honestly and
caused the release-tier misdiagnosis to be repeated across sessions.

FG-617 remains closed. Its safe refusal when an operator manually runs the release tier from a dirty
builder checkout is a separate accepted limitation. Do not reopen or fold it into this ticket unless
new path-2 evidence actually identifies that tier as the cause.

## Direction (decided)

**Evidence first. Do not change commit ordering or release-test behavior on an unproven cause.**

1. Preserve the complete post-fixer `VerificationResult` when verification fails.
2. Carry the failed step name, command/tier, and bounded output through `FixDispatch`, `RoundRecord`,
   the durable review-loop note, and the `review_loop.verification_finished` event (or an equally
   queryable dedicated post-fix verification event).
3. Reproduce one correct-fix round and one deliberately failing-fix round with that instrumentation.
4. Use the resulting evidence to fix the demonstrated cause. If the cause differs between the two
   historical shapes, split only after the evidence proves two independent defects.

Do not:

- Commit before verification merely to satisfy a guessed clean-tree precondition.
- Skip `test:extended`.
- Relax FG-575's checkout-state assertion.
- Claim the release tier caused the historical stop unless the newly preserved step output says so.

## Acceptance criteria

- A post-fixer verification failure names every failed step and records its command/tier and useful
  output in the run note and durable events. `verification_failed` with only dirty paths is impossible.
- Unit/integration coverage drives a post-fixer verifier where one step passes and another fails, and
  proves the failing step and its output survive through `FixDispatch`, `RoundRecord`, and rendering.
- Round-entry dirty-tree verification and post-fixer verification are covered separately, with their
  actual tier selection asserted so they cannot be conflated again.
- A real reproduction of the FG-559 shape records the previously missing evidence. The ticket's root
  cause and implementation direction are updated from that evidence before any behavioral fix lands.
- After the demonstrated cause is fixed, a correct fixer diff is verified and committed without hand
  intervention.
- A deliberately bad fixer diff still fails verification, remains uncommitted, and reports the exact
  failing evidence.
- No required tier is skipped, verify-before-commit remains intact, and FG-575's strict
  invoking-checkout invariant is unchanged.

## Corrections recorded

- The original filing asserted that release integration failures caused the post-fixer stop. That was
  unsupported: the cited integration run was performed separately by the fixer.
- A later amendment narrowed the defect to `--local-extended`. That was also wrong:
  `verifyWithReuse()` runs `scriptsForVerification()` on any dirty tree, and this project's required
  gate list includes `test:extended` without the flag.
- Neither correction explains the observed path-2 failure. Until the discarded verification result is
  preserved, the honest root cause is **unknown**.

## Independently rediscovered 2026-07-27 (FG-566 red re-check)

red-backend flagged the same call site while reviewing FG-566, confirming this path is real and still
open after FG-566 lands:

> The post-revert verification inside `fix()` runs local verification with no readiness preflight, so
> on the CI-reuse path an unprepared workspace still reports an environment fault as a code failure —
> the exact FG-566 defect shape, surviving on a sibling path in the same consumer.
> Evidence: `src/cli/commands/review-loop.ts:924` — `const verification = runVerify(localFallbackScripts(), { cwd: ctx.projectDir });`
> with no preceding `prepareLocalVerification` call, unlike the two round-entry sites at `:603` and `:686`.

FG-566 deliberately fenced this site to FG-625 rather than fixing it (its architect artifact fences
"FG-625 — the post-fixer verification path. OUT, except that the step-detail channel this ticket must
add on the round-entry path is the same channel FG-625 will consume"). So this ticket now owns two
distinct defects on the same line: the missing step detail it was filed for, AND the missing readiness
preflight. Address both, or explicitly split the second out — but do not close this ticket having
fixed only the naming half while `:924` still misclassifies an environment fault as a code failure.
