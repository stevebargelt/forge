---
id: FG-559
type: story
status: active
title: "agents mounted on a linked git worktree have NO working git — .git is a gitdir: pointer file into the parent repo, which is outside the container mount"
created: 2026-07-14
---

## Problem

A linked git worktree's `.git` is a **file**, not a directory. It contains a single line:

```
gitdir: /Users/stevebargelt/code/forge/.git/worktrees/<worktree-name>
```

`forge invoke --project <worktree>` bind-mounts only the worktree directory at `/project`. The
`gitdir:` target lives under the **parent repo's** `.git/`, which is **not** mounted. So inside the
container the pointer dangles and **every git command fails**:

```
fatal: not a git repository:
/Users/stevebargelt/code/forge/.git/worktrees/forge-durable-continuation-audit
```

No `git log`, no `git diff`, no `git blame`, no `git show` — the agent has the file tree and nothing
else.

## How it surfaced (2026-07-14)

A `red-wide` closure review of the FG-552 PRD was asked to verify "no files changed beyond the PRD"
and "the five BD edits were status-label-only" by diffing two committed SHAs. It could not run git at
all, and correctly returned `inconclusive` — refusing to certify two of its four checks rather than
substituting a visual read of the working tree for the diff it was told to run. Re-running the same
review against a standalone clone (real `.git` directory, both SHAs present) returned PASS on all four
checks with the diff actually executed.

The failure was only caught because that brief made a diff **mandatory**. Which is the real worry:

## Why this matters more than it looks

**Today it degrades silently.** An agent that would have consulted history just... doesn't, works from
the file tree, and reports success. Nothing errors at the forge level. There is no signal.

**The blast radius is about to grow:**
- **FG-345** — git worktrees for ALL agents — makes worktree mounts the default, not the exception.
- **FG-425** already creates per-attempt publication worktrees.
- **`forge review-loop`** reviewer/fixer agents are precisely the population that needs `git diff` to
  do their job at all. A reviewer that cannot see the diff it is reviewing is not a reviewer.

Shipping broad worktree adoption without fixing this leaves every history-dependent agent blind while
appearing to work.

## Possible directions (not yet decided)

1. **Also bind-mount the `gitdir:` target** (`<parent>/.git/worktrees/<name>`) plus whatever of the
   parent `.git` object store the worktree needs. Note the worktree's objects/refs live in the PARENT
   `.git`, so a partial mount may not be enough — needs verification, and read-only mounting of a
   parent `.git` into a red's container has its own trust questions.
2. **Rewrite `.git` inside the container** to point at a mounted location.
3. **Give the agent a standalone clone** instead of a linked worktree when it needs history (what the
   FG-552 closure check did as a one-off workaround — it is scaffolding, not a fix).
4. **Fail loudly**: detect a dangling `gitdir:` at container start and refuse/warn, so the degradation
   is never silent. This is the cheapest half-measure and is arguably required regardless of which of
   1–3 is chosen.

## Acceptance criteria

- An agent invoked with `--project <linked-worktree>` can run `git log`, `git diff <sha>..<sha>`, and
  `git show` against the project's real history.
- A `red-wide` review-loop reviewer mounted on a worktree can diff the range it is reviewing.
- A regression test covers the linked-worktree case specifically (a plain-clone mount would pass
  vacuously and prove nothing — the test must use a real linked worktree).
- Silent degradation is impossible: if git is unavailable in the mount, forge says so rather than
  letting the agent proceed history-blind.

---

## Design decision (2026-07-25, architecture pass — run-fg-559-linked-worktree-git-access-design-a999b7)

**Decided: direction 1 — bind-mount the parent `.git` READ-ONLY at its own host absolute path.**
The linked worktree is unchanged. Scope of this ticket is pieces A + B below; piece C is FG-621.

### The experiment settled the question the ticket flagged as unverified — and the ticket guessed wrong

Nine mount configurations against a real linked worktree, negative control run first:

| Mounted | Result |
|---|---|
| worktree dir only (today) | all git commands fail — defect reproduced byte-identical |
| + `<parent>/.git/worktrees/<name>` only | **ALL FAIL** — the minimal direction-1 mount is *totally* insufficient, not partially |
| + `<parent>/.git/{HEAD, refs, objects}` | log / diff `<sha>..<sha>` / show / status / blame pass |
| + `packed-refs` | **required in practice** — without it `git rev-parse origin/main` is ambiguous; nearly every ref a reviewer names is packed |
| whole `<parent>/.git`, READ-ONLY | every read passes with clean stderr; every write refused at the kernel (`index.lock`, `update-ref` → Permission denied) |
| whole `<parent>/.git`, read-write | reads pass; a container successfully created a branch in the parent repo — **not proposed** |

**Structural fact that makes it work with zero env vars:** `<parent>/.git/worktrees/<name>/commondir`
holds the RELATIVE string `../..`; only the `gitdir:` line in the worktree's `.git` file is absolute.
Resolution is an absolute hop into the admin dir, then a relative hop up two levels. Both hops must
land on mounted storage — which is why mounting the admin dir alone fails.

### Read-surface decision — ACCEPTED (operator, 2026-07-25)

A whole-`.git` read-only mount widens what reds can READ: every branch and tag, remote-tracking refs,
the reflog, remote URLs from config, and — under FG-345 default-on — every concurrent sibling task's
`forge/<runId>/<taskId>` branch.

**Accepted deliberately.** The red isolation contract is that reds do not receive other panel members'
findings or the blue transcript. Those artifacts are not stored in `.git`. The contract does not
promise git refs are hidden, and reds need repository history to review honestly. A red-only
`--single-branch` clone would add substantial machinery without protecting an existing invariant.

**Do NOT build the red-only clone path.**

The WRITE guarantee (`docs/invariants.md` #9) is untouched — refusal is the kernel mount flag, proven,
not a prompt instruction.

### Correction to the architecture pass — recorded, and it is an FG-345 decision

The design rests on "agents do not write git today and are not required to". **The second clause is
wrong.** `src/v2/worktree-lifecycle.ts:231-242` states the contract explicitly:

> *Contract: agents are expected to commit their work on the task branch. As a safety net, this
> function auto-stages and commits any uncommitted changes in the worktree before merging.*

Host-side commit is the documented SAFETY NET, not the primary path. A read-only parent `.git`
deliberately prevents blue agents from committing at all, demoting the documented primary path to
an always-unused one.

**This does not block FG-559** — host auto-commit preserves the agent's filesystem work either way.
But it must remain an EXPLICIT FG-345 decision before the worktree default-on flip, one of:

- Declare host-side commit authoritative under worktree mode, and update the now-stale contract at
  `worktree-lifecycle.ts:231`; **or**
- Implement the writable-git follow-up (FG-621) before default-on.

FG-559 must NOT silently resolve this by editing that contract comment.

### Rejected alternatives

- **Direction 2 (env vars).** `GIT_DIR`/`GIT_WORK_TREE` work functionally from an arbitrary container
  path, but are GLOBAL to the container process tree — demonstrated: `git -C /tmp/other status` inside
  an unrelated repo reported the WORKTREE's status. Trades a loud "not a git repository" for a silent
  wrong-repo answer. Strictly worse than the bug.
- **Direction 2 (rewrite `.git` in-container).** Incompatible by construction for reds — the `.git`
  file lives inside the worktree, which for a red is `:ro`. Rewriting host-side breaks the host's own
  git for that path.
- **Direction 1-scoped (least-privilege writable subpaths).** Protects the ref namespace (proven) but
  leaves `objects/` writable and therefore deletable — the container can destroy the parent's history.
  Four separately-scoped nested mounts including a reflog dir that only surfaced by running it.
  Complexity with no boundary guarantee.
- **Direction 3 as the DEFAULT.** Not rejected on cost — measured 0.106s for `clone --shared`, and the
  `cp -R node_modules` half is redundant inside forge (a clone of the same commit has a byte-identical
  lockfile, so `planDependencyVolumes` resolves the same already-populated FG-376 volume). Rejected on
  blast radius: "needs history" is undecidable up front, so default-on means cloning always, which
  means replacing worktrees, which means re-plumbing merge-back (`mergeWorktreeBranch`,
  `mergeChildIntoIntegration`, `mergeIntegrationBranchToHead`), FG-353 fan-out integration ordering,
  FG-354 persistence-check, FG-425 publication worktrees, and reconcile's host-side orphan-evidence
  probe. Direction 1 makes the existing machinery correct instead of replacing it. **Retained as a
  deliberate escape hatch** for writable-git cases (see FG-621).

## Scope: piece A — loud detection

- Host-side **mount-plan assertion**. The host CANNOT detect this by resolving the path — on the host
  the `gitdir:` target resolves perfectly, which is exactly why this stayed silent. The check must ask:
  *"`PROJECT_DIR/.git` is a pointer to a path OUTSIDE `PROJECT_DIR`; is that path in the mount list I am
  about to hand docker?"* — an assertion about the argv being built, not a filesystem stat.
- **Refuse, not warn, and unconditionally.** The predicate has essentially no false-positive class: a
  non-git project has no `.git`; a plain clone has a `.git` directory; a correctly-mounted worktree
  passes. It can only catch the exact broken state.
- Container-side probe (`git rev-parse --git-dir` at entrypoint) on the same footing as the existing
  dependency-provisioning exit-code contract. The host check proves the mount was PLANNED; the
  container check proves it RESOLVED. They fail for different reasons.
- **Fix the two latent surfaces found in the same pass:**
  - `src/v2/spawn.ts:501` — `existsSync(join(projectDir, ".git"))` returns true for the pointer FILE
    (verified: `existsSync: true, isDirectory: false`). This single line is the seam the defect walked
    through.
  - `docker/forge-test.sh:306` — the `[[ -d "$SRC_DIR/.git" ]]` guard is FALSE for a worktree, so the
    `/tmp/forge-work` scratch is created with NO git at all, silently. Its own comment claims "the
    scratch is a git repo like the source is" — untrue for a worktree project. This is on the path
    every agent uses to run tests.

## Scope: piece B — the read-only parent `.git` mount

- One additional mount, conditional on `PROJECT_DIR` being a linked worktree, `:ro` for EVERY agent
  class (blue and red alike). `PROJECT_MODE` stays rw-for-blue / ro-for-red as today.
- **Compute it in `buildDockerArgs`, not in runtime YAML.** The mount set is declared per-runtime
  across six `seeds/runtimes/*.yml` and resolved from a versioned seed generation — a YAML-declared
  optional mount must be added to all six AND picked up by a regenerated seed, so an old generation
  silently keeps the broken behavior. `src/v2/spawn.ts:316-376` (the node_modules shadow / FG-376
  dependency volumes) is the established precedent for a dynamic, conditional, ro/rw-asymmetric mount
  computed in code. Follow that shape; do not invent a new mechanism.
- Consequence to accept: the mount reproduces a HOST absolute path inside the container, so container
  paths stop being hermetic. That is the price of not setting `GIT_DIR`, and it is the right price.

## Test strategy

Tier: **`*.worktree.test.ts`** (`npm run test:worktree`) — the tier is chosen by the slowest operation
and this fixture calls `git worktree add`. Runs in CI's required `test-extended` gate via the
`worktree` job. Closest structural precedent: `src/v2/fg351-worktree-lifecycle.worktree.test.ts`.

Fixture: build a real repo with several commits (so `<shaA>..<shaB>` is a non-empty range), then
`git worktree add -b <branch> <wtPath> <sha>`. Materialize the candidate container view by copying the
worktree tree to a DIFFERENT path (modelling it landing at `/project`) and recreating ONLY the mount
set under the original host-absolute paths. Needs no docker; runs in well under a second.

Must assert:

- `statSync(<wt>/.git).isFile()` is true — the guard against the vacuous-pass mode the AC calls out.
  If a refactor turns the fixture into a plain clone, this is what stops the test silently passing.
- **NEGATIVE CONTROL, load-bearing:** with only the worktree materialized, `git log` MUST fail with the
  dangling-gitdir error. Every positive result is only meaningful because this control fails first.
- With the mount set materialized: `git log`, `git diff <shaA>..<shaB>`, `git show <sha>` all exit 0
  with NON-EMPTY output. Assert on output, not just exit code.
- A ref that exists only in `packed-refs` resolves — the assertion that catches the near-miss where
  `{HEAD, refs, objects}` looks sufficient and then fails on `origin/main`.
- Under a read-only mount set: reads succeed AND a write (`git update-ref` / `commit`) is refused.
  This pins the red boundary as a test, not a comment.
- The mount-plan predicate: a dispatch whose `PROJECT_DIR` is a linked worktree produces argv
  containing the parent `.git` bind, and the piece-A check refuses when it does not. Argv-shape alone
  would be vacuous — it must be paired with the functional harness above.

Coverage limit: the harness cannot prove a real `:ro` bind mount behaves like the chmod simulation.
It behaves more strictly, so the gap is in the safe direction — but capture one manual
`forge invoke --project <worktree>` smoke run against a real container as acceptance evidence.

## Accepted risks

- **Host-side `git gc` / auto-repack** on the parent while containers hold it mounted can make a
  packfile vanish underneath a reader. `gc.auto` fires off ordinary commit activity, not just explicit
  `git gc`, and under FG-345 default-on the host writes the parent `.git` during a run. Accepted: the
  failure is a loud git error, not a wrong answer. Revisit if observed. Does not block B.
- **Omitting `.git/config`** from a narrowed mount set would silently change git behavior on repos
  using extensions (partial clone promisor, `extensions.worktreeConfig`, non-default
  `repositoryformatversion`). Trials passed with no config at all — which is precisely the trap.
  Mitigated by mounting the whole `.git` rather than a narrowed set.
- **`objects/info/alternates`** in the parent is not followed when planning the mount. A parent that is
  itself a `--shared` clone is rare and the failure is loud. Documented limit, not handled.
