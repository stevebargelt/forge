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
- **A leaked snapshot target has unbounded cost** — every subsequent host ticket write fans out to it, unbounded work and unbounded disk per write. Mitigated by the late commit point and by releasing the row on every path where the container is known not to be reading it (below).
- **Over-eager cleanup is worse than a leak**: the snapshot directory is the SOURCE of a live `:ro` bind, so deleting it strands a running agent. Mitigated by the retention rule below.
- **The refusal must not become the new silence in reverse** — a refusal that fires on every normal project would be ignored within a week. Hence the `markdown` / `unknown` distinction is load-bearing, not cosmetic.

---

## Implementation Notes

### The split, and the publication commit point

- **The input is `run.projectDir`, INCLUDING for reds — and that is a security boundary, not a tidiness point.** `runContainer`'s `args.projectDir` is the run's project directory for a blue step, but for a red it is the publisher's CANDIDATE worktree (`runRedsAgainst(candidateDir)`), whose tracked `.forge/config.yml` is content merged out of the agent's private clone. Resolving from it lets an agent commit any unregistered or foreign `project_key` and make every subsequent red on a ticketed run resolve `unknown` and be refused before its container starts — an identity-forgery vector against the review lane itself, with blue steps unaffected. FG-608's registry cross-check still refuses the copied key (no cross-project read is possible), but the refusal it feeds is now terminal, which is what turns a contained guard into a denial-of-review. So the question is asked of the run record and of nothing else; the red still MOUNTS the candidate. A run with no recorded `projectDir` degrades to an unresolvable authority rather than falling back to a workspace — the parameter is `string | undefined` precisely so there is no default to reach for.
- **Resolution is PURE.** `resolveDispatchBacklogAuthority(projectDir, taskId, ticketId?)` writes no marker, registers no target, publishes nothing and records no evidence. Its whole descriptor — including `hostDir`, which is deterministic from the task id — is knowable before any side effect has occurred. That is precisely what makes a late commit point reachable.
- **Publication is the side-effecting half** and holds all five effects that used to live inline: the authority-marker write, `releaseFinishedTargets`, `registerSnapshotTarget`, `publishSnapshotOnce`, and the single dispatch-evidence write. `recordDispatchEvidence` is called from here and nowhere else, exactly once per dispatch — asserted by COUNT, not by existence, because a path that has never fired in production is exactly where a double-write hides.
- **The commit point is immediately BEFORE `buildDockerArgs`, and the argv is built out of what publication produced.** It cannot be later: the snapshot directory is the source of a `:ro` bind, so the artifact must exist before `docker run`. Deferring past container start would also mean any host ticket write in that window never fans out to this target — fan-out happens only on writes, so a missed write is missed permanently. Bounded leak beats unbounded staleness; the leak is what compensation is for.
- **It sits before the argv build rather than after it because `FORGE_DISPATCHED_TICKET` and the evidence row must name the SAME revision the snapshot carries.** The first cut published after building the argv, so the env var was derived from the value read at RESOLVE time — which is now separated from publication by the whole dependency block (image pull plus install, minutes). A host ticket amendment inside that window lands in the published snapshot while the evidence names the revision before it, and the in-container reader asserts the task was BUILT FROM the dispatched revision: a trust-gate write path emitting a claim its own artifact contradicts. Publication therefore re-reads the ticket adjacent to writing the snapshot, and the argv is built from the returned descriptor.
- Everything before the commit point — preflight, mountpoints, dependency provisioning, the probe, every `cleanupStagedAuth` site — runs with nothing registered and no artifact created. A `buildDockerArgs` failure now falls AFTER it and is compensated like any other pre-exec failure; that catch always called `compensatePublishedSnapshot()` for exactly this reason.
- **AC4's refusal is applied TWICE**, to the resolved value and again to what publication produced. Publication can degrade a healthy `db` resolution to `unknown` (a marker that will not write, a snapshot that will not publish), and the container's reader refuses every backlog read on an `unknown` marker — so a refusal decided only against the resolved value still starts a ticketed container that runs blind. One predicate (`dispatchIsBlind`) evaluated at both points, so the two can never drift.
- **A db-mode dispatch with no readable row for its ticket is refused too.** The store resolving is not the same fact as the ticket being IN it: a ticket removed, archived or unreadable between `forge new --ticket` (which validates it) and dispatch used to fall through silently to a `db` authority carrying no evidence — zero evidence writes, no `FORGE_DISPATCHED_TICKET`, and a snapshot that does not contain the ticket the run is anchored to. AC7's exactly-one-evidence-write guarantee becoming zero writes, with nothing recorded either way.
- **The classification must be carried, not re-derived.** The old bare `catch` discarded a typed `ProjectIdentityConflictError` carrying the config / registered / evidence keys. That error is thrown ONLY on the declared-key path; the no-key path returns `markdown` without throwing. So the distinction AC4 needs already exists structurally at the throw site and was lost only by flattening it.

### The artifact-deletion polarity — get this backwards and you strand a live mount

The rule, stated positively:

1. The registration **ROW is released exactly where Forge KNOWS no container can still be reading the snapshot** — either none was created, or the one that was has exited. It is NOT unconditional, and the correction is to my own earlier instruction: I told the plan the row is released on every pre-start failure path, and the implementation applied that to the exec `catch`, which in detached mode is reachable AFTER the daemon created the container. Fan-out to a registered target is how a post-start ticket amendment reaches a running agent (FG-608); releasing there cuts a live agent off from every later amendment — exactly the delivery the registration exists to provide. **The same unknown that forbids deleting the directory forbids asserting the container is gone.** The artifact decision correctly needs no start flag; the row decision does.
2. The **ARTIFACT is deleted ONLY against an authoritative daemon-side fact that no container was created.** The absence of an in-process start record is NOT that fact.
3. Every executor failure is artifact-ambiguous: retain the bytes. Release the row only where the container's absence is positively known.

Concretely, at the three post-publication failure shapes:

| shape | what is known | row |
|---|---|---|
| `buildDockerArgs` throws | exec was never called — no container exists | released |
| exec throws, executor signals start, no start recorded | the daemon never created a container | released |
| exec throws with a start recorded (or an executor that never signals) | the container may be RUNNING | retained — it keeps receiving amendments |
| exec RETURNS (any exit code, 0 or nonzero) | the container has exited | released |

The retained-row case has a stated bound rather than an implied one: `failTask` has already run, so the task reads `finished`, and the project's next dispatch reclaims the bytes through `releaseFinishedTargets` — the same task-status-driven behaviour that governed this shape before compensation existed. Keeping the row therefore buys the live agent continued amendment delivery for as long as no other dispatch for that project happens; it does not make the directory permanent, and it does not add a way for a live mount to be unlinked that FG-608's GC did not already have.

The last exec-RETURNS row is the one the first implementation missed entirely. Compensation covered only the exec-throw path, so an ordinary nonzero executor return — by far the more common failure — failed the task with its target still registered, and every subsequent host ticket write for that project kept fanning out to a directory nothing would ever read again. That is the unbounded per-write cost this ticket exists to bound, reintroduced through the common path. It is released once, immediately after `exec` returns, rather than at each of the eight terminal returns below it.

No executor contract surfaces the required fact, and this is named per contract so it is not implementer discretion:

- **Detached** (`src/v2/docker-exec.ts:337-378`, the production default): the fact exists internally — `docker run -d` exiting non-zero means the daemon declined — but it is NOT surfaced. Both that branch and the entry/stdin staging failure flatten to `return 1`, indistinguishable from a container that ran and exited 1. Worse, the start record arrives WITH the signal, so an exec that throws after the daemon created the container but before the signal was observed leaves any in-process flag false; deleting there strands a live mount.
- **Attached** (`defaultDockerExec`): `onContainerStarted` fires immediately after spawning the docker CLIENT, before daemon-side creation is known.
- **Legacy / fake executors**: the start record is granted up front, before anything is known.

Therefore the dispatch layer **always retains bytes**. Deletion stays where FG-608 already put it: `releaseFinishedTargets` deletes only against the positive `finished` fact, which is a DIFFERENT fact from no-creation.

**Reclamation — and the sweep this originally assumed did not exist.** The first version of this record asserted that a compensated dispatch's retained bytes were reclaimed by the project's next dispatch, because `failTask` makes the task read `finished`. That was **wrong, and the shipped seam test recorded the opposite behaviour as intended**: `releaseFinishedTargets` iterates `liveSnapshotTargets` (`released_at IS NULL`), and compensation has already set `released_at`, so the released-but-present directory — holding the project's full ticket bodies — was reachable by no sweep at all. A repo-wide grep confirmed nothing else reaps `~/.forge/backlog-snapshots`. A durable decision record documenting a reclamation guarantee the implementation cannot provide is worse than no record, because the next engineer reasons from it.

So the sweep now exists rather than the claim being softened. `reclaimReleasedTargets` (`src/backlog/snapshot.ts`) iterates `releasedSnapshotTargets` and runs from the same dispatch-time moment as `releaseFinishedTargets`, with the same injected liveness predicate and the same polarity — bytes are deleted against the POSITIVE `finished` fact, a released row whose task still reads `live` keeps its bytes, and an unresolvable task ages out on `UNKNOWN_TARGET_SWEEP_MS`. The target row is deleted with the bytes, so the table stays bounded too. AC6's two costs are therefore bounded separately and both by a NAMED sweep: the per-write fan-out ends the instant the row is released, and the one-off disk cost ends at the project's next dispatch.

The one case covered by neither compensation nor either sweep is a live-but-abandoned task: a host crash in the pre-container window leaves the task `running`, and `if (state === "live") continue` means neither sweep retires it. **FG-533's reconcile pre-container sweep** is what turns that task into `pre_container_crash`, after which reclamation proceeds. We rely on that sweep and say so; we do not add a third sweeper.

**The two AC4 outcomes are never flattened into one terminal state.** The refusal records a real `FailureKind` rather than `classify({})`'s generic `unknown`, which `retry-policy.ts` declares retryable — so the deterministic identity refusal was being advertised as re-dispatchable, and every retry/recovery consumer (`forge show`, `forge retry`, `forge recover`, the campaign policy, all of which read `failure_kind` through `failureKindFromEvents` and nothing else) saw one indistinguishable outcome. Three kinds, split by whether re-resolving can possibly reach a different answer: `backlog_authority_conflict` (non-retryable — the declared `project_key` and the registry disagree, identically on every re-dispatch), `backlog_authority_unresolvable` (retryable — the store or the publication failed, and a retry RE-RESOLVES from scratch rather than reusing a cached failure), and `backlog_ticket_unreadable` (retryable once the ticket is restored). Both `POLICY` and `BLOCKER_BY_FAILURE_KIND` are `Record<FailureKind, …>`, so none of the three could be added without a named disposition.

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
