# Decision: A dispatched task's backlog authority is resolved from Forge-owned run state, not from the per-task workspace

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

But every clone-dispatched task went ticket-blind. `prepareBacklogSnapshotMount` resolved the store from `ctx.PROJECT_DIR`, which on the clone substrate is the CLONE; the clone's derived evidence does not match the registered `project_key`'s, so FG-608's guard threw, the bare `catch` wrote `mode: "unknown", projectKey: null`, and the container refused every backlog read. Measured over the fourteen dispatches preceding this ticket: the two reds resolved `db` correctly (they mount the project directory read-only), and **all twelve worktree/clone-dispatched tasks were blind** — architect, tech-lead and every engineer, across multiple runs.

The cost is specific. `forge new feature` REQUIRES `--ticket` precisely so work is anchored to acceptance criteria, and the phases that do the work could not read them. It failed silently from the operator's side; it only surfaced because one architect volunteered it in `openQuestions`. The shipping reviewer is a red and *does* resolve correctly, so the failure mode was "built without seeing the acceptance criteria, then judged against them" — the expensive ordering.

Two constraints bounded the answer before options were on the table:

- **No schema change to `~/.forge/forge.db`.** Every running forge process re-runs migrations on next DB open, so the blast radius is machine-wide, and this defect is degrading every pipeline run today. `runs.project_dir` already carries what is needed.
- **The dispatch path's never-throws property is load-bearing.** `prepareBacklogSnapshotMount`'s contract is what keeps a markdown-mode dispatch that never needed a snapshot, and every red, unabortable.

---

## Problem

Which directory's identity should a dispatched task's backlog authority be resolved against, given that the workspace the task runs in is a disposable clone whose repository evidence deliberately diverges from the project's?

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

Resolve authority against the run's recorded project directory (`runs.project_dir`) at the dispatch chokepoint, and hand that directory to the argv builder. The per-task clone is never asked the identity question.

**Pros**:
- Correct for BOTH substrates and BOTH remote-bearing and remoteless projects, because it stops depending on substrate convergence entirely.
- Requires nothing from the clone's `.git` — not readable, not present, not trustworthy.
- **No schema change.** `runs.project_dir` already exists and is populated before dispatch.
- Touches neither the guard, the registry, nor evidence derivation — only WHICH DIRECTORY is handed to `resolveBacklogStore`.

**Cons**:
- Widens the resolver's cache key: `resolveBacklogStore` memoizes per resolved path with a short TTL, so a run's concurrent dispatches now share one key — better hit rate, but one poisoned resolution is shared for the TTL. Recorded as a known property.

---

### Option C: Carry the resolved authority forward on the run rather than re-deriving it per task

**Pros**:
- Strongest form of the same principle — identity resolved once, at a Forge-owned moment, and read thereafter.

**Cons**:
- Requires durable per-run identity storage, which pulls in the machine-wide migration blast radius and a run-creation-path coverage sweep. FG-666 needs none of it while every pipeline run is degrading today.

**Deferred to FG-663, not rejected on correctness.** Option B is forward-compatible with it: when FG-663 lands durable per-run identity, **this call's INPUT changes and no consumer moves.**

---

### Option D: Treat a workspace under `~/.forge/worktrees/clones/` as trusted by path prefix

**Cons**:
- Specifically rejected. It is a shape check standing in for a fact, and it would exempt exactly the directory the agent controls. The project directory must be carried forward AS DATA; the clone must never be detected-and-exempted by its path.

---

## Decision

**Chose**: Option B — resolve from Forge-owned run state.

**Rationale**: Option A was disproven on its own mechanism and, even repaired, would have made identity depend on state the gated party can rewrite. Option B is the only one that fixes the remoteless case, and it fixes it by removing a dependency rather than adding one: the question "which project does this checkout own?" is simply never posed to a disposable clone. FG-608 did not malfunction — it correctly refused to answer a question that should never have been asked. Option C is the same principle at a stronger scope and is deferred, not abandoned, precisely because Option B leaves its landing site free.

**Scope, deliberately narrow.** This is a one-question change: which directory `resolveBacklogStore` is called with. The dispatch's behaviour when authority does NOT resolve is unchanged — the marker says `unknown`, the container refuses its backlog reads, and the dispatch proceeds. The one addition is that the host now says so out loud (below), because a degradation discoverable only in an agent's prose is what hid this for twelve dispatches.

---

## Consequences

**Positive**:
- Architect, tech-lead and engineer containers read the real ticket. `forge backlog show <ticket>` succeeds for a ticketed pipeline run on both substrates.
- An unresolved authority is now visible to the operator at dispatch time rather than inferable only from an agent's prose.
- Identity questions are no longer answerable from inside the argv builder at all, so the next project-semantic concern added there cannot inherit this bug.

**Negative / Trade-offs**:
- `buildDockerArgs` gains an optional parameter, so "which directory answers identity" is now a caller's decision rather than an implicit one. That is the point, but it is one more thing a new dispatch caller can get wrong — the fallback is the pre-FG-666 behaviour, which is right only for a caller whose `PROJECT_DIR` really is the project.
- A run's dispatches share one resolver cache entry.

**Risks**:
- **The signal must not become the new silence in reverse** — one that fires on every normal project would be ignored within a week. Hence the `markdown` / `unknown` distinction is load-bearing, not cosmetic: a project that declares no `project_key` resolves `markdown` cleanly and emits nothing.

---

## Implementation Notes

- **The input is `run.projectDir`, INCLUDING for reds — and that is a security boundary, not a tidiness point.** `runContainer`'s `args.projectDir` is the run's project directory for a blue step, but for a red it is the publisher's CANDIDATE worktree (`runRedsAgainst(candidateDir)`), whose tracked `.forge/config.yml` is content merged out of the agent's private clone. Resolving from it would let an agent commit a foreign `project_key` and change what its own reviewers resolve. FG-608's registry cross-check refuses the copied key either way, so no cross-project read is possible — but the question is asked of the run record and of nothing else. The red still MOUNTS the candidate; only the identity question moved.
- **`buildDockerArgs` takes the authority directory as an option, and defaults to `ctx.PROJECT_DIR`.** `forge invoke` provisions no workspace — its `PROJECT_DIR` *is* the project — so it passes nothing and its behaviour is byte-identical to before. `runNext` passes `getRun(runId)?.projectDir`. Nothing else about the publication path moved: the marker write, `releaseFinishedTargets`, `registerSnapshotTarget` and `publishSnapshotOnce` still happen in one never-throwing call from the argv builder, exactly as FG-608 left them.
- **An unresolved authority is stated on the host and recorded.** `resolveBacklogStore` throwing is the one branch that means "a `project_key` was declared and the cross-repository guard would not honour it" — the no-key path returns `markdown` and never throws, so the distinction exists structurally at the throw site. That branch now prints the resolver's own message (which names the config, registered and evidence keys) and logs `container.backlog_authority_unresolved` against the task, alongside the marker it already wrote. It is a report, not a gate: no refusal, no failure kind, no change to what the container gets.

### What was NOT done

- **FG-608's cross-repository guard was NOT weakened.** `src/backlog/storage-mode.ts`, `src/store/project-registry.ts` and `src/util/repository-identity.ts` are unmodified. The proof is a PAIR of assertions in one test, differing only in substrate: a per-task clone of a correctly-registered checkout resolves `db` with the correct `project_key`, AND a genuinely different repository whose config carries a COPIED `project_key` still refuses. Any change that makes the first pass by weakening the guard breaks the second; neither half alone is the proof.
- **No schema change.** `runs.project_dir` already exists.
- **No path-prefix trust** for the clone directory.
- **No refusal, and no new failure kinds.** A dispatch whose authority will not resolve behaves as it did before this ticket. The failure taxonomy, the retry policy and the campaign blocker policy are untouched.
- **The ticket id is still not threaded through the dispatch path**, so `SpawnContext.TICKET_ID` remains unset by production dispatch and `recordDispatchEvidence` still fires only where FG-608 left it. Nothing in this decision needs it.
- **`forge new --ticket` was not redesigned**, and the `forge invoke` seam — which already resolved correctly — is unchanged and pinned by test rather than by argument.
- **FG-663's read-time re-derivation** (`src/util/projects.ts`, the dashboard's "Unknown repository" fallbacks) is out of scope. Same principle, different time horizon: FG-666 acts at dispatch time where the checkout provably exists; FG-663 at read time, after it is gone.

### Testing the coupling that broke

Every existing FG-608 test calls `prepareBacklogSnapshotMount(projectDir, …)` directly — which is exactly why FG-621's substrate change went unnoticed: the argument-production path stopped being exercised, and a test that constructs the resolver's input itself cannot detect a caller passing the wrong input. The regression pins therefore drive the **production dispatch seam** (`runNext` with an injected executor) over fixtures built the way production builds them, and assert on what that path produced — the marker, the argv, and the ticket bodies readable through the mounted snapshot. They cover a remote-bearing parent, a REMOTELESS parent, a private clone of each, and a linked worktree asserted against its parent for the convergence contrast. The file names `*.worktree.test.ts` are themselves a fossil of the era when the assumption held.

---

## Revisit Conditions

- **When FG-663 lands durable per-run project identity**, this call's input should move from `runs.project_dir` to that record. Nothing downstream needs to change — that is the property Option C's deferral was bought with.
- If a dispatch substrate changes again (a third option beyond linked worktree and private clone), the substrate matrix test is the thing that must be extended BEFORE the substrate is switched.
- If the shared resolver cache entry per run ever turns a transient resolution failure into a run-wide wave, revisit the cache key rather than the resolution point.
