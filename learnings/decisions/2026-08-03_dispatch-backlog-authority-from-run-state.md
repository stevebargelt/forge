# Decision: A dispatched task's backlog authority is resolved from Forge-owned run state, and publication is a separate, late, compensated commit

**ID**: FORGE-DEC-031
**Date**: 2026-08-03
**Status**: Decided
**Decided by**: forge (FG-666)
**Supersedes**: N/A — EXTENDS FORGE-DEC-029 (the mount asserts authority; this decides what authority is resolved *against*)
**Scope**: forge
**Elevated from**: N/A

---

## Context

FG-608 made a project's ticket store authoritative per `project_key` and added a cross-repository guard: a checkout whose derived repository evidence does not match the evidence the registered `project_key` was minted against is REFUSED rather than answered from a store that may belong to another project. FORGE-DEC-029 then made an agent container's ticket authority an unforgeable host-written marker in a `:ro` mount.

FG-621 later moved the dispatch substrate for mutating tasks from linked git worktrees to a private per-task `git clone --shared` under `~/.forge/worktrees/clones/`. Nothing in that change touched the backlog, and nothing failed.

But every clone-dispatched task went ticket-blind. `buildBacklogSnapshotMount` resolved the store from `ctx.PROJECT_DIR`, which on the clone substrate is the CLONE; the clone's derived evidence does not match the registered `project_key`'s, so FG-608's guard threw, the bare `catch` wrote `mode: "unknown", projectKey: null`, and the container refused every backlog read. Measured over the fourteen dispatches preceding this ticket: the two reds resolved `db` correctly (they mount the project directory read-only), and **all twelve worktree/clone-dispatched tasks were blind** — architect, tech-lead and every engineer, across multiple runs.

The cost is specific. `forge new feature` REQUIRES `--ticket` precisely so work is anchored to acceptance criteria, and the phases that do the work could not read them. It failed silently from the operator's side; it only surfaced because one architect volunteered it in `openQuestions`. The shipping reviewer is a red and *does* resolve correctly, so the failure mode was "built without seeing the acceptance criteria, then judged against them" — the expensive ordering.

Two constraints bounded the answer before options were on the table:

- **No schema change to `~/.forge/forge.db`.** Every running forge process re-runs migrations on next DB open, so the blast radius is machine-wide, and this defect is degrading every pipeline run today. `runs.project_dir` already carries what is needed.
- **The dispatch path's never-throws property is load-bearing.** `prepareBacklogSnapshotMount`'s contract (`src/v2/spawn.ts:230-237`) is what keeps a markdown-mode dispatch that never needed a snapshot, and every red, unabortable.

---

## Problem

Which directory's identity should a dispatched task's backlog authority be resolved against, given that the workspace the task runs in is a disposable clone whose repository evidence deliberately diverges from the project's — and how is the resulting snapshot target's lifecycle made safe when argv construction or spawn can still fail after authority has been resolved?

---

## The corrected mechanism (the first explanation was wrong)

The ticket originally said the clone diverges because `repositoryCheckoutIdentity` derives its key from the preferred normalized remote and the clone's `origin` is a filesystem path. **That is wrong**, and the error mattered because it was the only thing keeping Option A alive.

`normalizeGitRemoteUrl('/path/to/parent')` returns `undefined` (`src/util/github-url.ts:23-47`). A bare filesystem path contains no `://`, so the scp-form branch is skipped; it contains no scp-form colon either, so `new URL()` throws and the function returns `undefined`. `derivePreferredRemoteIdentity` therefore yields NOTHING for a per-task clone — the remote rung does not produce a different key, **it does not participate at all**. `repositoryCheckoutIdentity` (`src/util/repository-identity.ts:66-105`) falls through to the clone's OWN `.git` common dir.

Measured on real repositories:

| substrate | resolved evidence | source rung |
|---|---|---|
| parent with a GitHub origin | `repo-cf99076afdd4f871cce9` | `remote` |
| its `git clone --shared` | `repo-57516466a7d1b5b264c0` | `git-common-dir` |
| remoteless parent | `repo-bc4c72f4f42d6fa19753` | `git-common-dir` |
| its `git clone --shared` | `repo-61140ac9ef253401a706` | `git-common-dir` |
| **linked worktree of that parent** | `repo-bc4c72f4f42d6fa19753` | `git-common-dir` |

The last row is the whole story: **a linked worktree CONVERGES with its parent; a private clone does not.** That is why this bug did not exist before FG-621, and why nothing caught the change — the coupling between "backlog authority resolves correctly" and "the dispatch substrate converges to the parent's evidence" was real, undeclared, and untested.

---

## Options Considered

### Option A: Preserve or rewrite the clone's origin remote so its derived evidence matches

`git clone --origin`, or rewrite the clone's remote to the source checkout's own origin, so the remote rung yields the parent's key.

**Pros**:
- Local to `worktree-lifecycle.ts`; no dispatch-path change at all.

**Cons** — rejected on three independent grounds:
- **It does not do what it says.** `git clone --origin` RENAMES the remote; it does not change its URL. And per the corrected mechanism, a local-path origin does not normalize as a remote at all, so the remote rung is not where the divergence lives.
- **It has no answer for a remoteless project.** Parent `repo-bc4c…` vs clone `repo-6114…`, both resolved via `git-common-dir`. There is no origin URL to copy, and `--shared` gives the clone its own common dir, so NEITHER rung converges. Option A covers at best the remote-bearing subset.
- **Worst in principle: it makes backlog authority depend on the clone's `.git/config`** — agent-writable workspace state, in a container where the agent has passwordless root. The adjacent FG-621 mount planner already states the rule: workspace-resident git state "is only ever a value to verify, never a path to trust". Option A makes identity forgeable in exactly the way the neighbouring code refuses.

---

### Option B: Resolve the backlog store from Forge-owned run state, not from the per-task workspace ✅

Resolve authority against the run's recorded project directory (`runs.project_dir`), at the dispatch chokepoint, and hand the resolved descriptor to the argv builder. The per-task clone is never asked the identity question.

**Pros**:
- Correct for BOTH substrates and BOTH remote-bearing and remoteless projects, because it stops depending on substrate convergence entirely.
- Requires nothing from the clone's `.git` — not readable, not present, not trustworthy.
- **No schema change.** `runs.project_dir` already exists and is populated before dispatch; `run.metadata.ticketId` (FG-472) already carries the ticket.
- Moves resolution to a point where the control-plane receipt is still open, which is what makes an operator surface reachable at all.
- Touches neither the guard, the registry, nor evidence derivation — only WHICH DIRECTORY is handed to `resolveBacklogStore`.

**Cons**:
- Widens the resolver's cache key: `resolveBacklogStore` memoizes per resolved path with a short TTL, so a run's concurrent dispatches now share one key — better hit rate, but one poisoned resolution is shared for the TTL. Recorded as a known property.
- Splits a function that was one call into resolution + publication, which introduces a lifecycle question that did not exist before (see Implementation Notes).

---

### Option C: Carry the resolved authority forward on the run rather than re-deriving it per task

**Pros**:
- Strongest form of the same principle — identity resolved once, at a Forge-owned moment, and read thereafter.

**Cons**:
- Requires durable per-run identity storage, which pulls in the machine-wide migration blast radius and a run-creation-path coverage sweep. FG-666's acceptance criteria need none of it while every pipeline run is degrading today.

**Deferred to FG-663, not rejected on correctness.** Option B is forward-compatible with it: when FG-663 lands durable per-run identity, **this primitive's INPUT changes and no consumer moves.**

---

### Option D: Treat a workspace under `~/.forge/worktrees/clones/` as trusted by path prefix

**Cons**:
- Specifically rejected. It is a shape check standing in for a fact, and it would exempt exactly the directory the agent controls. The project directory must be carried forward AS DATA; the clone must never be detected-and-exempted by its path.

---

## Decision

**Chose**: Option B — resolve from Forge-owned run state, with resolution split from publication.

**Rationale**: Option A was disproven on its own mechanism and, even repaired, would have made identity depend on state the gated party can rewrite. Option B is the only one that fixes the remoteless case, and it fixes it by removing a dependency rather than adding one: the question "which project does this checkout own?" is simply never posed to a disposable clone. FG-608 did not malfunction — it correctly refused to answer a question that should never have been asked. Option C is the same principle at a stronger scope and is deferred, not abandoned, precisely because Option B leaves its landing site free.

---

## Consequences

**Positive**:
- Architect, tech-lead and engineer containers read the real ticket. `forge backlog show <ticket>` succeeds for a ticketed pipeline run on both substrates.
- A ticketed dispatch that cannot resolve its authority now FAILS LOUDLY, pre-container, on three surfaces — the class of silence that hid this for twelve dispatches is closed at the seam.
- Identity questions are no longer answerable from inside the argv builder at all, so the next project-semantic concern added there cannot inherit this bug.
- FG-608's dispatch-evidence path (`FORGE_DISPATCHED_TICKET`) fires in production for the first time — `SpawnContext.TICKET_ID` was declared and consumed but set by no production dispatch, only by a test.

**Negative / Trade-offs**:
- One function became three (resolve / publish / release) plus an optional parameter on `buildDockerArgs`, and the publication commit point is now an explicit thing to reason about rather than an implicit one.
- A run's dispatches share one resolver cache entry.

**Risks**:
- **A leaked snapshot target has unbounded cost** — every subsequent host ticket write fans out to it, unbounded work and unbounded disk per write. Mitigated by the late commit point and unconditional row release below.
- **Over-eager cleanup is worse than a leak**: the snapshot directory is the SOURCE of a live `:ro` bind, so deleting it strands a running agent. Mitigated by the retention rule below.
- **The refusal must not become the new silence in reverse** — a refusal that fires on every normal project would be ignored within a week. Hence the `markdown` / `unknown` distinction is load-bearing, not cosmetic.

---

## Implementation Notes

### The split, and the publication commit point

- **Resolution is PURE.** `resolveDispatchBacklogAuthority(projectDir, taskId, ticketId?)` writes no marker, registers no target, publishes nothing and records no evidence. Its whole descriptor — including `hostDir`, which is deterministic from the task id — is knowable before any side effect has occurred. That is precisely what makes a late commit point reachable.
- **Publication is the side-effecting half** and holds all five effects that used to live inline: the authority-marker write, `releaseFinishedTargets`, `registerSnapshotTarget`, `publishSnapshotOnce`, and the single dispatch-evidence write. `recordDispatchEvidence` is called from here and nowhere else, exactly once per dispatch — asserted by COUNT, not by existence, because a path that has never fired in production is exactly where a double-write hides.
- **The commit point is between a SUCCESSFUL `buildDockerArgs` and the exec call.** It cannot be later: the snapshot directory is the source of a `:ro` bind, so the artifact must exist before `docker run`. Deferring past container start would also mean any host ticket write in that window never fans out to this target — fan-out happens only on writes, so a missed write is missed permanently. Bounded leak beats unbounded staleness; the leak is what compensation is for.
- Everything before that point — preflight, mountpoints, dependency provisioning, the probe, every `cleanupStagedAuth` site, and a `buildDockerArgs` failure — runs with nothing registered and no artifact created, so there is nothing to compensate.
- **The classification must be carried, not re-derived.** The old bare `catch` discarded a typed `ProjectIdentityConflictError` carrying the config / registered / evidence keys. That error is thrown ONLY on the declared-key path; the no-key path returns `markdown` without throwing. So the distinction AC4 needs already exists structurally at the throw site and was lost only by flattening it.

### The artifact-deletion polarity — get this backwards and you strand a live mount

The rule, stated positively:

1. The registration **ROW is released UNCONDITIONALLY** on every pre-start failure path after publication. Releasing the row only stops future fan-out and is always safe.
2. The **ARTIFACT is deleted ONLY against an authoritative daemon-side fact that no container was created.** The absence of an in-process start record is NOT that fact.
3. Every other failure is artifact-ambiguous: retain the bytes, still release the row.

No executor contract surfaces the required fact, and this is named per contract so it is not implementer discretion:

- **Detached** (`src/v2/docker-exec.ts:337-378`, the production default): the fact exists internally — `docker run -d` exiting non-zero means the daemon declined — but it is NOT surfaced. Both that branch and the entry/stdin staging failure flatten to `return 1`, indistinguishable from a container that ran and exited 1. Worse, the start record arrives WITH the signal, so an exec that throws after the daemon created the container but before the signal was observed leaves any in-process flag false; deleting there strands a live mount.
- **Attached** (`defaultDockerExec`): `onContainerStarted` fires immediately after spawning the docker CLIENT, before daemon-side creation is known.
- **Legacy / fake executors**: the start record is granted up front, before anything is known.

Therefore the dispatch layer **always retains bytes**. Deletion stays where FG-608 already put it: `releaseFinishedTargets` deletes only against the positive `finished` fact, which is a DIFFERENT fact from no-creation.

**Reclamation, stated honestly rather than assumed.** A compensated dispatch calls `failTask`, and `failed` reads as `finished`, so retained bytes are reclaimed on the project's NEXT dispatch. The one case covered by neither compensation nor that GC is a live-but-abandoned task: a host crash in the pre-container window leaves the task `running`, and `if (state === "live") continue` means the age sweep never retires it. **FG-533's reconcile pre-container sweep** is what turns that task into `pre_container_crash`, after which the GC reclaims it. We rely on that sweep and say so; we do not add a second sweeper.

### What was NOT done

- **FG-608's cross-repository guard was NOT weakened.** `src/backlog/storage-mode.ts`, `src/store/project-registry.ts` and `src/util/repository-identity.ts` are unmodified. The proof is a PAIR of tests differing only in substrate: a per-task clone of a correctly-registered checkout resolves `db` with the correct `project_key`, AND a genuinely different repository whose config carries a COPIED `project_key` still refuses. Any change that makes the first pass by weakening the guard breaks the second; neither test alone is the proof.
- **No schema change.** `runs.project_dir` and `run.metadata.ticketId` already exist.
- **No path-prefix trust** for the clone directory.
- **`forge new --ticket` was not redesigned.** Enforcement is at the dispatch seam only, and the `forge invoke` seam — which already resolves correctly, since it passes the real project directory with no worktree substitution — is unchanged and pinned by test rather than by argument.
- **FG-663's read-time re-derivation** (`src/util/projects.ts`, the dashboard's "Unknown repository" fallbacks) is out of scope. Same principle, different time horizon: FG-666 acts at dispatch time where the checkout provably exists; FG-663 at read time, after it is gone.

### Testing the coupling that broke

Every existing FG-608 test calls `prepareBacklogSnapshotMount(projectDir, …)` directly — which is exactly why FG-621's substrate change went unnoticed: the argument-production path stopped being exercised, and a test that constructs the resolver's input itself cannot detect a caller passing the wrong input. The regression pins therefore drive the **production dispatch seam** with an injected executor, over fixtures built the way production builds them (`git clone --quiet --shared --no-checkout`), covering a remote-bearing parent, a REMOTELESS parent, and a linked worktree asserted against its parent for the convergence contrast. The file names `*.worktree.test.ts` are themselves a fossil of the era when the assumption held.

---

## Revisit Conditions

- **When FG-663 lands durable per-run project identity**, this primitive's input should move from `runs.project_dir` to that record. Nothing downstream needs to change — that is the property Option C's deferral was bought with.
- If a dispatch substrate changes again (a third option beyond linked worktree and private clone), the substrate matrix test is the thing that must be extended BEFORE the substrate is switched.
- If an executor contract ever surfaces an authoritative "the daemon created no container" signal, the artifact-retention rule can tighten to delete on that positive fact — and only then.
- If the shared resolver cache entry per run ever turns a transient resolution failure into a run-wide wave, revisit the cache key rather than the resolution point.
