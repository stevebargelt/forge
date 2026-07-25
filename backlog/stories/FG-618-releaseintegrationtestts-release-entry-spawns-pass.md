---
id: FG-618
type: story
status: active
title: release.integration.test.ts release-entry spawns pass the ambient FORGE_HOME instead of a disposable one (hermeticity)
created: 2026-07-25
---

## Observation

Surfaced during the FG-575 sweep of `src/v2/release.integration.test.ts`, and deliberately left
unfixed there as out of scope.

`runEntryUnderHostilePath` and three other release-entry spawns in that file pass the AMBIENT
`FORGE_HOME`:

```
FORGE_HOME: process.env.FORGE_HOME ?? ""
```

rather than a disposable one. Everywhere else the file is careful about this — `buildHome` exists
precisely so a build does not land a copy of node in the operator's real `~/.forge/interpreters`
just for running the suite (FG-571).

## Why this is an observation, not a defect

The commands those spawns run were checked against what they do with `FORGE_HOME`:

- `forge init` only READS it (`planCommitMsgHook` resolves the hook target from it).
- `release provenance` and bare `dashboard` are read-only.

So nothing writes to the operator's real forge home today, and none of it touches git state. The
FG-575 invariant (the invoking repository's git state is unchanged across the run) is not affected.

## Why it is still worth closing

It is an unpinned ambient dependency in a suite whose entire point is hermetic, executed
verification. It holds only because the current command set happens to be read-only — a property
nobody is asserting and the next command added to one of those spawns could silently break. Pinning
it costs nothing and removes the need to re-audit.

## Scope

Pass a disposable `FORGE_HOME` (the existing `buildHome`, or a sibling under the same temp
workspace) to the four release-entry spawns, unless a specific test genuinely requires the ambient
one — in which case say so in a comment at that site.

## Acceptance criteria

- No spawn in `src/v2/release.integration.test.ts` passes the ambient `FORGE_HOME` without an
  explicit comment justifying it.
- The file still passes on the macOS host and in Linux CI (`test-extended`).
- The FG-575 last-in-file git-state assertion still passes.

## Relations

Follow-up from FG-575 (found during its required whole-file sweep). Low priority — hermeticity
hardening, no known live impact.
