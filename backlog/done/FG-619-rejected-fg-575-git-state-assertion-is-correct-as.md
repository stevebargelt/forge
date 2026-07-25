---
id: FG-619
type: story
status: done
title: "REJECTED: FG-575 git-state assertion is correct as shipped — the false red was a concurrently-mutated checkout, not a defect"
created: 2026-07-25
closed: 2026-07-25
closed_commit: c29264d
---

## REJECTED — invalid validation environment, not a defective assertion

This ticket was filed 2026-07-25 and rejected the same day, before any work was done on it. The body
below records why, so that the next person who hits the same symptom does not re-file it.

## The symptom that prompted it

Running the FG-575-fixed `src/v2/release.integration.test.ts` in the live forge checkout returned
34/35, failing only the last-in-file assertion that the invoking repository's git state is unchanged.
The diff was two untracked backlog files:

```
+ '?? backlog/stories/FG-617-....md'
+ '?? backlog/stories/FG-618-....md'
```

`head`, `branch`, and `stash` were byte-identical; every pre-existing uncommitted file was untouched.

## Why that is not a defect

**The orchestrator filed those two tickets while the suite was running.** The test asserts "this
checkout is unchanged across the run." The checkout changed during the run. The assertion correctly
reported a changed checkout, and its output named both offending files precisely enough to diagnose
in seconds.

That is an invalid validation environment — a proof about a quiescent resource was run against a
resource being concurrently mutated by the person running the proof. A re-run against a stable tree
passed 35/35, and after the test-engineer's additions, 36/36.

## Why the proposed direction was wrong

The original proposal was to keep `head` / `branch` / `stash` strict but loosen the porcelain
comparison to "no new entry appeared under a path the suite is responsible for."

That is incoherent. An unexpected test write is BY DEFINITION in an unexpected path, so the loosened
assertion would stop catching exactly the regression it exists for. It trades a false RED caused by
operator error for a false GREEN in the failure mode that loses work. Wrong direction on the axis
that matters.

It also conflicts with FG-575's acceptance criteria, which say in as many words: "no new or rewritten
commits, no stash entries, and no modified/untracked files." Filing a follow-up that relaxes that
would amend a just-shipped AC by the back door — the precise thing the standing rule adopted on
2026-07-24 forbids (amend an AC explicitly and before closing, or leave it alone).

## The correct response

Procedural, not code:

- **Serialize mutations.** Do not write to the checkout — file tickets, commit, edit notes — while a
  proof about that checkout is running.
- **Or run the proof against a quiescent disposable clone**, which is the documented pattern for this
  tier anyway (FG-614 precedent, and FG-575's own validation used exactly this).

No change to the assertion. Its strictness is the property that makes it worth having.

## Related

The tier's genuine preconditions (a committed `src/`, package.json and lockfile) are discussed in
FG-617. Nothing from this ticket needs to move there — that is a different constraint, already
covered.
