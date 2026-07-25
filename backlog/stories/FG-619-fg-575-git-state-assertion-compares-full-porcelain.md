---
id: FG-619
type: story
status: active
title: FG-575 git-state assertion compares full porcelain — unrelated concurrent writes to the checkout turn the suite red (host-only false red)
created: 2026-07-25
---

## Problem

FG-575 added a last-in-file assertion to `src/v2/release.integration.test.ts` that the invoking
repository's git state is unchanged across the whole suite run:

```
assert.deepEqual(gitState(checkoutRoot), checkoutStateBefore, ...)
```

`gitState` captures `head`, `branch`, `stash`, and the FULL `git status --porcelain` output. The
porcelain half includes untracked files anywhere in the repo, so **any** change to the working tree
during the ~40s run fails the suite — including changes that have nothing to do with the test.

## How it surfaced (2026-07-25, during FG-575's own validation)

Running the fixed suite in the live forge checkout returned 34/35, failing only this assertion. The
entire diff was two backlog tickets the orchestrator filed *while the suite was running*:

```
+ '?? backlog/stories/FG-617-....md'
+ '?? backlog/stories/FG-618-....md'
```

`head`, `branch`, and `stash` were byte-identical, and every pre-existing uncommitted file was
untouched. A re-run against a stable tree passed 35/35. So the failure was a genuine false red: the
invariant the ticket cares about — the suite does not commit, stash, or clean the invoking
repository — held perfectly.

## Why it matters here specifically

This repo routinely has concurrent activity in the same checkout: a second orchestrator session
filing tickets, an agent writing scratch files, an editor dropping a swap file. Any of those landing
inside the run window turns a green suite red. CI is unaffected (isolated checkout, nothing
concurrent), so this is a host-only flake — the same asymmetry class as FG-556 and FG-575 itself,
just in the opposite direction.

## Severity

**Fail-safe.** It can only produce a FALSE RED, never a false green: a suite that actually committed
into the checkout would still fail this assertion loudly. Nothing can be lost. Filed as a follow-up
rather than a blocker on that basis — the FG-575 invariant is not weakened by this ticket existing.

## Possible direction

Keep `head`, `branch`, and `stash` compared strictly — those are precisely what "destroyed my work"
means, and none of them can move from unrelated concurrent activity. Loosen only the porcelain
comparison so it asserts what the ticket actually promises:

- no pre-existing entry DISAPPEARED (that is the defect signature — the operator's dirty file being
  swept into a commit made the entry vanish), and
- no new entry appeared under a path the suite is responsible for.

An entry appearing elsewhere in the repo mid-run is someone else's write, not this suite's.

Whatever shape is chosen must not reintroduce vacuity: the FG-575 mutation proof (reinstating
`git add` + `commit` into the passed-in root) must still turn this assertion RED.

## Acceptance criteria

- The assertion still fails when the pre-FG-575 defect is reintroduced (commit into the invoking
  checkout) — verify by the same mutation proof FG-575 used.
- The assertion does NOT fail when an unrelated untracked file appears in the repo mid-run.
- `head` / `branch` / `stash` remain strictly compared.
- Passes on the macOS host and in Linux CI (`test-extended`).

## Relations

Follow-up from FG-575 (the assertion it introduced). Sibling in spirit to FG-557 — a host-only,
load-or-environment-sensitive test condition that is green in CI and red on a working host.
