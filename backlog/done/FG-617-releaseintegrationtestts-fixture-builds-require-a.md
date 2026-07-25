---
id: FG-617
type: story
status: done
title: release.integration.test.ts fixture builds require a clean invoking checkout — in-process builds resolve builder identity from the module's own location
created: 2026-07-25
closed: 2026-07-25
---

## Problem

FG-575 stopped `release.integration.test.ts` from committing into the invoking checkout. A
consequence surfaced while validating it: the file's sixteen FIXTURE `buildRelease()` calls are
IN-PROCESS, so `resolveBuilderCommit` (`src/v2/release.ts`) derives their BUILDER identity from this
module's own location — the invoking checkout — and then refuses a dirty builder:

```
assertCommitDescribesTree(bRoot, ["src", "package.json", builderLockfile], "builder");
```

The removed `commitSource(sourceRoot)` had been silently satisfying that precondition for the whole
file, not just for the shared build. With it gone, running the tier from a checkout whose `src/`,
`package.json`, or lockfile is dirty fails ~20 tests.

FG-575 made this legible rather than mysterious — `before()` now calls
`assertBuilderCheckoutIsCommitted()`, which states the precondition once, names the dirty paths, and
points at the remedies — but the underlying constraint remains.

## Scope of the constraint (verified, narrower than it first appears)

The builder check covers ONLY `src/`, `package.json`, and the selected lockfile. The other
commit-bound asset dirs (`seeds/`, `scripts/`, `docker/`, `dashboard/`) are checked against
`--source`, which since FG-575 is always the isolated copy and therefore clean by construction.

So: a dirty `docs/`, `backlog/`, or `seeds/` does NOT block the tier. Only `src/`, `package.json`, or
the lockfile does. That is the common case for someone actively editing `src/` — i.e. exactly the
person most likely to want to run the integration tier.

## Why this is not a defect

The refusal is a refusal, never a write — safe, loud, actionable. It is the same precondition the
sibling `launch-cli.integration` and `launch-r2.integration` tests already carry. FG-575's AC 1 is
explicitly scoped to "from a clean checkout", and its operational AC — that the tier can no longer
destroy anything in the working checkout — is fully met. This ticket is the ergonomics gap, not a
correctness gap.

## Possible direction

Route the fixture builds through an isolated builder too, so the builder root is a clean copy rather
than the invoking checkout — e.g. load `release.ts` from the isolated copy so `import.meta.url`
resolves inside it. Needs verification that this preserves what each fixture test is actually
asserting; several of them exercise builder-vs-source identity distinctions deliberately, and a
change here must not make `builderCommit == commit` hold vacuously.

## Acceptance criteria

- `npm run test:integration` passes from a checkout with uncommitted `src/` changes.
- The builder-vs-source identity assertions still discriminate — specifically, the successor-build
  test that asserts release A's `builderCommit` is recorded SEPARATELY from release B's source
  `commit` must still fail if those are conflated.
- The FG-575 invariant is preserved: the invoking repository's git state is unchanged across the
  run (the existing last-in-file assertion must still pass).
- `assertBuilderCheckoutIsCommitted()` is removed or narrowed to whatever precondition genuinely
  remains, rather than left stating one that no longer applies.

## Relations

Follow-up from FG-575 (merge commit recorded there). Not a blocker for it — filed under the
review-disposition policy as broader scope than the originating ticket's invariant.

---

## Closed 2026-07-25 — accepted limitation, not a defect

This ticket's own body describes a REFUSAL, never a wrong write: the root integration tier declines to run when the invoking checkout's `src/`, `package.json` or lockfile is dirty. The suite fails safely and says why.

That is the correct behavior for a builder precondition it cannot otherwise guarantee. It cost one confusing session (~30 false reds until the tree was committed), which is a documentation/ergonomics matter rather than a defect — the mitigation is simply to commit before running that tier.

Reopen only if the refusal is shown to fire on a CLEAN checkout, which would be a real false positive.
