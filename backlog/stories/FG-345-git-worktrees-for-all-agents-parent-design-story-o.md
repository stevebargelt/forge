---
id: FG-345
type: story
status: active
title: "isolated Git workspaces for ALL agents: writable private Git for mutators + read-only worktrees for non-mutators"
created: 2026-06-22
---

### Isolated Git workspaces for ALL agents: private commit authority + Forge publication authority

(story/active — parent decision record + design brief. The remaining writable-Git work needs an implementable child before isolation becomes default-on.)

**CORRECTED DECISION (2026-07-26; supersedes the uniform-substrate wording below): every agent runs away from the live checkout in an isolated Git workspace, but the substrate follows capability.** Mutating agents get private writable Git metadata and may commit on private task branches. Non-mutating agents get stable read-only linked worktrees with read-only history. Forge alone constructs, validates, and publishes the candidate. The invariant is isolation and authority separation, not "one Git mechanism for every role."

## Why isolated workspaces for every agent

1. **Silent lost-updates are unacceptably costly.** Concurrent rw/blue fan-out shares ONE working dir (all blue containers get `projectMode: rw` against the same `PROJECT_DIR`; `dispatchFanoutStep` runs up to 4 concurrent containers on the identical host path). Collisions are NOT recoverable merge conflicts — they are last-writer-wins filesystem races: torn/partial writes, silent clobbers, no detection. Isolated branches and workspaces CONVERT these silent races into detectable integration conflicts.
2. **Uniform lifecycle does not require a uniform Git substrate.** Every task still has recorded identity, base SHA, workspace, branch/ref, process, result, and disposition. Mutators need writable private Git; reviewers need a stable read-only snapshot. Forcing both through a linked worktree makes the parent object store either dangerously writable or agent commits impossible.
3. **forge-on-forge host protection + consistent review snapshots.** Isolated workspaces keep EVERY agent container off the live host source, and a red reviewing a stable snapshot beats reviewing a still-mutating `/project`.

This brings blue write-isolation up to the OS-enforced standard forge already mandates for reds (today it is nothing but an honor-system file-independence contract).

## Cost is a non-factor (do not relitigate)

~222ms / ~12MB per `git worktree add` on this repo (762 files; git objects shared). The FG-559 experiment measured the viable mutator substrate, `git clone --shared`, at 0.106s and <1MB of new storage, with local commits working and the parent remaining unwritable. Creation lands in the parallel dispatch wave. grpcfuse is not a new tax; node_modules is already container-local ext4 (DEC-019). Caveat: a 50k-file monorepo needs a one-off checkout benchmark before promising "free" there.

## HARD DESIGN CONSTRAINTS (these are the real design pivots — the architecture pass must answer each)

1. **Worktrees catch same-file TEXTUAL races only; semantic cross-file breakage merges CLEAN.** Agent A changes a signature in `foo.ts`; agent B (own worktree) calls the old signature in `bar.ts` → `git merge` succeeds with ZERO conflict → broken code merged with no signal. **Therefore worktrees are NECESSARY BUT NOT SUFFICIENT: the design MUST include a post-merge integration gate (build + test the MERGED result).** The trap: believing worktrees make parallel work safe. They relocate the risk, not remove it.
2. **Most forge work is SEQUENTIAL; naive isolated workspaces add a merge step to a path that cannot collide.** A pipeline runs architect → tech-lead → engineer → test-engineer in series; each sees the prior step today because it is just there on `/project`. If every step branches off `HEAD`, the engineer can't see the tech-lead's work, forcing 3-way merges between steps that never conflicted. **Required: base each sequential workspace on the exact accepted PREVIOUS candidate, not all-off-HEAD.**
3. **The reconcile/merge step is genuine net-new orchestrator complexity.** New "agent succeeded but reconcile failed" failure state, conflict-resolution ownership, persistence-check rework, lockfile / node_modules merge questions. Runtime cost nil; design cost real.
4. **Isolated disposable workspaces make real container-side dependency installs safe.** A private clone or worktree can have its own `node_modules` install or dependency volume, letting engineers/test-engineers/reviewers run normal `npm test` / typecheck commands without corrupting the live host checkout. This is not solved by Git isolation alone because `node_modules` is ignored by git, but the isolated workspace is the safe writable boundary that makes dependency parity feasible. See FG-376.
5. **Commit authority is not publication authority.** A mutating agent may create private commits for checkpointing, recovery, rebase, bisect, and transport. Those commits are untrusted inputs. Forge must capture any remaining dirty files, build the candidate, run the required gates against that exact tree, and alone decide what reaches the target branch.

## Original architecture questions (retained for history)

These questions drove the existing FG-345 children. They are not a current blocker list; the binding
remaining default-on blockers are the implementation and acceptance proof recorded below.

- **Non-git projects.** Forge runs across arbitrary projects. If `/project` is NOT a git repo, what happens? Fail loud / fall back to current shared-mount behavior / `git init` a temp copy / require git for worktree mode. Must be explicit — silence here breaks cross-project use.
- **Untracked & ignored files (likely the biggest practical adoption risk).** `git worktree add` carries ONLY committed tracked content. `.env`, generated local config, design files, test fixtures, local-only assets, build caches — none come along. Define the contract: copy-in which classes? symlink? require committed? This is the most likely real-world breakage.
- **Dirty tracked state.** `git worktree add` deterministically EXCLUDES uncommitted host changes. For forge-on-forge (repo being developed IS the mounted project): commit/stash first, error on dirty, or carry the diff in.
- **Sequential-chaining state model.** "Branch off the previous step" is right, but WHERE is that branch/ref recorded — DB? run metadata? task result? task manifest? Without a concrete home, retry/cancel/reconcile get messy. (Relates to the reconcile subsystem in `src/v2/`.)
- **Red review timing.** Does a red review (a) the isolated candidate worktree pre-merge, (b) the merged phase result post-reconcile, or (c) both? A red on one child snapshot misses integration breakage; a red on merged output needs reconcile to run first. Resolve per phase type.
- **Reconcile failure states + cleanup.** New status/transition semantics when a merge conflicts; worktree teardown on success, failure, and orphan-recovery (interacts with the existing reconcile/orphan path).
- **persistence-check adaptation.** It currently asserts `files_modified` landed under the project bind mount; with worktrees that invariant moves to the worktree path.
- **Where the post-merge integration gate lives.** Almost certainly its OWN implementation story — wiring build+test of the merged result is separable from "create worktrees and merge them," and folding it into the first cut makes that cut too risky.

## Original proposed child-story split (historical)

1. **Worktree architecture plan / ADR** (this is the immediate next step — architecture-advisor).
2. per-task worktree lifecycle + manifest/DB state (create-before-dispatch, remove-after-exit, ref recording).
3. reconcile/merge primitive (single-branch merge-back + conflict surfacing).
4. fan-out merge ordering + conflict handling.
5. persistence-check adaptation.
6. red snapshot semantics.
7. post-merge integration gate (build+test merged result) — likely standalone.

## Implementation surface (for scoping only — not a plan)

`spawn.ts` (PROJECT_DIR → worktree path), `invoke.ts`/`runNext.ts` (worktree lifecycle), persistence-check subsystem, dependency provisioning for real container-side test runs (FG-376), the new reconcile/merge step, the integration gate. Relates: DEC-004 (orchestrator-on-host/agents-in-containers), DEC-019 (node_modules shadow volume), the red read-only mount principle, the existing `src/v2/` reconcile/orphan path.

---

## Folded in: FG-621 — the writable-in-container-git decision

FG-559 mounts the parent repo's `.git` READ-ONLY, which gives every agent working `git log`/`diff`/`show`
on a linked worktree but deliberately prevents in-container `git commit`.

That collides with the contract at `src/v2/worktree-lifecycle.ts:231-242`:

> *Contract: agents are expected to commit their work on the task branch. As a safety net, this function
> auto-stages and commits any uncommitted changes in the worktree before merging.*

Host-side commit is documented as the SAFETY NET, not the primary path. The read-only mount demotes the
documented primary path to an always-unused one. No work is lost at normal completion because the safety
net preserves the filesystem changes, but long-running agents lose checkpointing, recovery, rebase,
bisect, and stash. That is a material autonomy and resilience regression.

**DECIDED 2026-07-26: give mutating agents writable private Git. Do not make host-side commit the only
commit path.** This requires a separate writable object/ref namespace because a linked worktree shares
the parent's repository metadata by construction. The parent `.git` must never be writable by a
container. The cheap viable form is `git clone --shared` off read-only parent objects — measured 0.106s,
<1MB, full depth, local commits work, parent unwritable. Merge-back becomes host-side
`git fetch <clone> <branch>` followed by candidate construction, rather than assuming the task branch
already exists in the parent's ref namespace.

Worth stating plainly against this ticket's framing of worktrees as "OS-level write isolation":
**worktrees isolate the WORKING TREE, not the repository.** FG-559 is what exposed that distinction.

FG-621 should be reopened and made implementation-ready (or replaced by exactly one implementable child
that preserves its evidence). Do not file another architecture exploration.

## Course correction and authority contract (2026-07-26)

Forge began from the GasTown/GasCity worker-workspace + Refinery model, but copied the topology without
pinning its most important authority boundary. The drift is visible in the repository:

1. FG-340 reacted to agents creating partial/broken commits by declaring all agent commits the wrong
   boundary and making commit an orchestrator closeout action.
2. FG-352 then documented the opposite contract: agents are expected to commit, with host auto-commit
   only as a safety net.
3. Because both paths preserved files at normal completion, the contradiction remained latent.
4. FG-559 exposed that linked worktrees inside Docker have no usable Git unless the parent metadata is
   mounted. Mounting it read-only restored honest review while preventing commits.
5. The local safety constraint was then allowed to frame writable agent Git as an optional escape hatch,
   instead of preserving the original worker/refinery split.

The correction is not to let agents publish. It is to distinguish two authorities:

- **Private commit authority:** a mutating agent may commit freely on its isolated task branch. These are
  untrusted checkpoints and transport artifacts; Forge may squash or replace their commit boundaries.
- **Publication authority:** only Forge may construct the candidate, run the authoritative gates, update
  the target ref, push, merge, close work, or claim that a commit shipped.

FG-340 remains correct about agents not closing, merging, publishing, or treating partial commits as the
finished artifact. Its blanket no-commit rule is superseded for isolated mutating agents.

## Binding workspace and publication model

| Role capability | Workspace | Git write authority | Completion path |
|---|---|---|---|
| Mutating (blue/implementer/fixer/test writer) | Private writable clone at the exact recorded base SHA, on a deterministic private task branch | May create commits only in its private repo | Forge safety-commits remaining dirty files, fetches the branch, constructs and gates the candidate |
| Non-mutating (red/reviewer/narrative) | Stable linked worktree/snapshot with project and parent Git metadata read-only | None | Returns verdict/evidence; cannot alter the candidate |
| Forge controller/publisher | Host-owned integration/publication workspace | Owns candidate refs and target publication | Serializes only the target-branch publication window and publishes the exact validated candidate |

No new permanent LLM agent is required as a centralized component. Candidate construction, queueing,
gating, compare-and-swap publication, receipts, and recovery are deterministic controller/state-machine
work and belong in the existing serialized integration publisher. Serialization is keyed per project and
target branch, never global. Agents are dispatched only for judgment-bearing recovery such as resolving
a merge conflict or fixing a failed gate, and they receive a new isolated writable workspace.

## Minimal implementation and rollout

1. Keep worktree/isolation default-on blocked.
2. Make FG-621 implement the proven private-clone substrate for mutating agents; retain FG-559 for
   read-only agents.
3. Create each mutating clone from the exact recorded base SHA with its own writable refs, index, and
   object overlay; expose parent objects read-only only.
4. On completion, capture uncommitted tracked and untracked output with a Forge safety commit, fetch the
   private branch, and hand the resulting tree to the existing candidate publisher.
5. Gate the exact candidate that may be published. Agent commit topology is not automatically canonical
   project history; publication may squash it.
6. Preserve failed/crashed private workspaces until their work is recovered or explicitly discarded.
7. Dogfood forge-on-forge before flipping the default. Periodic WIP checkpointing is a later resilience
   improvement, not a blocker for restoring private commit authority.

## Acceptance proof required before default-on

- Two mutating agents can commit concurrently in independent private repositories.
- Neither agent can mutate the parent repository's refs, index, object store, or target branch.
- Uncommitted tracked and untracked output is captured at completion.
- A non-mutating/red agent can read the required history but cannot commit or update a ref.
- Sequential tasks start from the exact accepted predecessor candidate; fan-out tasks start from the same
  recorded base and integrate through the existing ordered candidate path.
- The tree Forge publishes is byte-for-byte the tree that passed the authoritative integration and red
  gates.
- A crash leaves a recoverable private workspace/branch and durable evidence; cleanup cannot silently
  discard it.
- Publication contention serializes only the affected project + target branch while other agents keep
  editing and committing in parallel.

---

## Current status (2026-07-26) — decision recorded, children dispatched

The operator decision this ticket was blocked on is **RECORDED and final**: mutating agents get private
writable Git; Forge retains publication authority. Do not reopen that question.

Children carrying the remaining default-on gate:

| Child | Owns | State |
|---|---|---|
| **FG-621** | The writable-Git path: per-task private `--shared` clone at the recorded base SHA, base selection from the accepted predecessor candidate, safety-commit capture, merge-back re-plumbing (`fetch` in place of `merge --ff-only`), stale-contract correction at `worktree-lifecycle.ts:231-242` | REOPENED 2026-07-26 and rewritten implementation-ready. No further architecture pass. |
| **FG-356** | Cleanup / recovery: orphan reaper in `reconcileRun`, locked-worktree hardening, retain-on-conflict. **Now must reap BOTH substrates** — linked worktrees for non-mutators and private clones for mutators. | Active, may proceed concurrently. Dependency FG-351 is done. |

**FG-345 does not close and isolation does not flip default-on until BOTH are proven**, per the
acceptance list above. Neither child's completion alone is sufficient.

Still owned by this parent (not delegated to either child, and each still a default-on blocker):

- The **post-merge integration gate** — build + test the MERGED result. Hard constraint 1: isolation
  converts silent filesystem races into detectable textual conflicts, but a cross-file semantic break
  merges CLEAN. Isolation is necessary, not sufficient. Needs its own story before default-on.
- **Publication-contention serialization** keyed per project + target branch, in the existing
  serialized integration publisher.
- The unanswered original architecture questions that survive the decision: non-git projects,
  untracked/ignored file carry-in contract, dirty host state under forge-on-forge, and red review
  timing (pre-merge candidate vs post-reconcile merged result).

---

## Default-on blocker recorded at FG-621's architect gate (2026-07-26): the Linux gate

FG-621 inherits `preflightWorktreeGate`'s Linux hard-fail (`src/v2/worktree-lifecycle.ts:63`), so its
AC 2 (parent-unwritable negative proof) and AC 11 (dogfood) evidence is **macOS-only**. That is
accepted for FG-621 itself, but it means **FG-621 alone cannot justify flipping isolation default-on
universally.**

At FG-345 closeout the choice must be made explicitly, and it is one of exactly two:

- **macOS-first default** — isolation defaults on for macOS only; Linux keeps the hard-fail and the
  shared-bind-mount path, documented as a platform limitation; or
- **lift the Linux gate** — which carries its own test burden (the `node_modules` bind-mount gap
  FG-358 tracks) and is a scope addition, not a flag change.

Linux support was deliberately NOT smuggled into FG-621. Whichever option is taken, it is a decision
this parent owns, alongside the post-merge integration gate and publication-contention items above.

## Aggregate default-on walk (2026-07-28)

Performed after FG-621 closed. Every item below was checked against the tree or a recorded decision, not
inferred from ticket state — two of this ticket's own stated blockers turned out to rest on superseded
premises.

### The 8-item acceptance list

| Required proof | Status |
|---|---|
| Two mutating agents commit concurrently in independent private repositories | **met** — FG-621 AC 1 |
| Neither agent can mutate the parent's refs, index, object store, or target branch | **met** — FG-621 AC 2, re-captured live at `71d7eae`: 11 negative probes, each refused by the kernel or git |
| Uncommitted tracked and untracked output captured at completion | **met** — FG-621 AC 3 |
| A non-mutating/red agent reads required history but cannot commit or update a ref | **met** — FG-621 AC 7 |
| Sequential tasks start from the accepted predecessor candidate; fan-out from the same recorded base | **met** — FG-621 AC 4, recorded-state assertions plus live corroboration |
| The published tree is byte-for-byte the tree that passed the gates | **met** — FG-621 AC 6 via FG-425's candidate gate |
| A crash leaves a recoverable private workspace and durable evidence; cleanup cannot silently discard it | **met** — FG-621 AC 9/AC 10 + FG-356 (reaps BOTH substrates) |
| Publication contention serializes only the affected project + target branch | **met** — FG-425 serialized publisher, keyed per project + target |

### Parent-owned blockers

| Blocker | Status |
|---|---|
| Post-merge integration gate (build + test the MERGED result) | **DONE** — FG-357, now run by FG-425's publisher against the candidate before publication |
| Publication-contention serialization per project + target branch | **DONE** — FG-425 |
| Original question: non-git projects | **ANSWERED** — `preflightWorktreeGate` gate 2 hard-fails with a named message and a `FORGE_NO_WORKTREES=1` escape. "Fail loud" was chosen. |
| Original question: dirty host state under forge-on-forge | **ANSWERED** — gate 3 hard-fails on a dirty tracked tree, with a documented `FORGE_WORKTREE_IGNORE_DIRTY=1` bypass. "Error on dirty" was chosen. |
| Original question: red review timing | **ANSWERED** — reds review the FG-425 **publication candidate** (post-merge, pre-publication). Confirmed live 2026-07-28: the architect reds' `controlPlane.projectDir` was `~/.forge/worktrees/publications/<attemptId>-r0`. |
| Original question: untracked / ignored carry-in contract | **OPEN — the one remaining blocker.** See below. |

### Two stated blockers that rest on superseded premises — corrected here

**The "Linux gate" fork is not a fork.** This ticket frames the closeout choice as *macOS-first default*
vs *lift the Linux gate*, and cites FG-358 as tracking the `node_modules` bind-mount gap. FG-358 was
**dropped as out-of-scope on 2026-07-02** (`6c0a1a6`), with the reasoning recorded in that commit: forge
runs only on the macOS host per DEC-004; "Linux" in the worktree gates refers to the agent CONTAINER,
never the host; and **FG-351's macOS-only gate is intended PERMANENT behavior, not a temporary gate**.
So "lift the Linux gate" is not an available option, macOS-only is not a compromise, and no choice needs
making here. The gate's own error text still says "see FG-358", which is stale and should be reworded to
state the permanence instead of implying a pending ticket.

**Both children are closed.** FG-621 closed 2026-07-28 with a 12-AC grid and live evidence at `71d7eae`;
FG-356 was already done.

### The remaining blocker: untracked / ignored carry-in

`git worktree add` and `git clone --shared --no-checkout` both carry **only committed tracked content**.
`node_modules` is handled separately by the dependency cache (macOS), but nothing carries in `.env`,
generated local config, local-only fixtures, or uncommitted assets. There is no carry-in mechanism in
`worktree-lifecycle.ts`, and no ticket owns the contract — this parent flagged it as *"likely the biggest
practical adoption risk"* and it is the last of the original questions still unanswered.

The failure mode matters more than the frequency: a project that needs a local `.env` gets a workspace
silently missing it, and the agent's failure looks like a code problem rather than an environment one.
That is the same silence-read-as-success class this parent's other gates were built to eliminate, so
shipping default-on without a stated contract would reintroduce it at the workspace boundary.

Note this is a **cross-project** risk, not a forge-on-forge one: forge's own tree needs no `.env`, so
dogfooding cannot surface it. The 10–20 prototype projects this orchestrator runs against are where it
would bite.

### Recommendation

**Hold default-on.** Every structural blocker is now closed and the two remaining "open questions" that
looked blocking were already decided; the honest remaining gap is exactly one item, and it is the one
this ticket predicted would hurt most in real use.

Recommended sequence before flipping:

1. Define and implement the untracked/ignored carry-in contract as one child (which classes carry in,
   by what mechanism, and what happens when the contract cannot be met) — or explicitly decide the
   contract is "nothing carries in; projects requiring local files must not enable worktree mode", and
   make THAT a loud preflight rather than a silent absence.
2. One clean end-to-end worktree-mode pipeline run. Worth stating plainly: before FG-628 shipped
   (2026-07-28), **every** red in a worktree-mode pipeline crashed before starting, so no worktree-mode
   pipeline had ever reached a gate verdict. Default-on before that would have silently disabled
   adversarial review across every run. One green end-to-end run is cheap insurance against the next
   defect of that shape.
3. Reword `preflightWorktreeGate`'s Linux message to state permanence rather than citing FG-358.
