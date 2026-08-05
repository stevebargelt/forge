# Decision: A writable `forge invoke` gets the SAME host-resolved, read-only dependency contract as a reviewer — keyed to dispatch shape, not to worktree-ness or entrypoint, with per-dispatch copies rejected in favor of shared read-only volumes

**ID**: FORGE-DEC-032
**Date**: 2026-08-04
**Status**: Decided
**Decided by**: forge (FG-678)
**Supersedes**: N/A — GENERALIZES FG-664's read-only gate and FG-376's worktree-only mount planner to a third dispatch shape neither covered
**Scope**: forge
**Elevated from**: N/A

---

## Context

A writable `forge invoke` was the one dispatch shape with no dependency provisioning at all. `forge invoke`'s reviewers and reds (FG-664) and a workflow's worktree-mode read-write primaries (FG-376) both resolved a dependency environment before their container started; a writable `forge invoke` — and a workflow read-write dispatch with no worktree — fell straight to `spawn.ts`'s legacy anonymous `node_modules` shadow volume. That volume starts **empty** and masks whatever the project bind mount carries at the same path, so a host-side `npm ci` run against the operator's own checkout before dispatch never reached the container. Whether the agent then noticed and installed for itself was left entirely to the agent.

Two identical `test-engineer` dispatches — same role, same model, same profile, same runtime, same workspace — diverged on exactly that. One reasoned its way to `npm ci` and validated the change. The other ran the target suite repeatedly, collected 1020 `ERR_MODULE_NOT_FOUND` errors, and reported honestly that it could not execute anything. Its task row still read `complete`. Both agents behaved defensibly; the platform had handed them different worlds. That is platform nondeterminism, not a difference in agent quality, and the fix belongs in the dispatch contract, not in a better prompt.

Two published contract statements were falsified by this hole and are reconciled elsewhere, not here: `docs/SCHEMA-CONTRACT.md`'s claim that `dependencyEnvironment` is absent on every read-write dispatch, and `docs/invariants.md`'s invariant 19 scoping host-side dependency resolution to read-only dispatches. This record is about the design decisions behind the fix, not the contract text itself.

---

## Problem

Three questions, deliberately answered together because any one alone leaves a hole open:

1. How does a writable `forge invoke` obtain the project's real, declared dependencies without reintroducing the write race FG-376's worktree-only gate exists to prevent — and without inventing a per-dispatch volume lifecycle Forge does not otherwise have?
2. What, mechanically, keeps the fix from being a change that "resolves an environment, writes a receipt, and still runs against an empty shadow" — a fix that looks shipped and changes nothing observable?
3. What happens to a project that declares dependencies but ships no lockfile Forge can key an environment on — and does the answer differ between a writable implementer and a read-only reviewer?

---

## Options Considered

### Option A: Per-dispatch isolated copies of the dependency tree

Give each writable dispatch its own private, freshly-installed `node_modules`, the way an isolated workspace gets its own git clone.

**Pros**:
- Isolation is obviously true by construction — nothing else can touch a copy that belongs to one dispatch.
- No new concurrency reasoning needed at mount time.

**Cons**:
- Isolation from the FG-376 concurrent-writer race comes from **read-only-ness**, not from copying — a `:ro` mount has no writer, so there is nothing to race, regardless of how many dispatches share it. A copy buys the same property at the cost of a full install per dispatch.
- It invents a per-task volume lifecycle that deliberately does not exist. `dependency-provisioning.ts`'s `removeDependencyVolumes` is scoped per-worktree, not per-task, and `worktree-lifecycle.ts` does not call it on ordinary per-task teardown — cache-key volumes are shared across every task that hashes to the same lockfile, so tearing one down when one task's worktree is removed would break every other task still referencing it. Per-dispatch copies would need the lifecycle this repo has specifically avoided building.
- Pure cost: every dispatch pays a fresh install instead of reusing a warm, already-attested cache key.

---

### Option B: Shared lockfile-keyed named volumes, resolved host-side, mounted read-only ✅

Reuse the exact mechanism FG-664 and FG-376 already built — the lockfile-keyed `forge-deps-*` volumes, resolved and attested by the host before any agent container exists — and extend it to the writable-invoke and non-worktree-rw shapes, mounting the result `:ro` there too.

**Pros**:
- No new mechanism. The provisioner, the per-cache-key lock, the probe, and the volume-naming scheme are all reused unchanged; the writable shape becomes a third caller of `resolveDependencyEnvironment`, not a second implementation of dependency resolution.
- Isolation is enforced by the kernel-level `:ro` bind, the same enforcement primitive already justified for the reviewer lane (an in-container assertion is unenforceable against passwordless root — see FORGE-DEC-030 Decision 2).
- Cache reuse survives: a warm key serves every dispatch shape that hashes to it, writable and read-only alike.

**Cons**:
- A cold-cache writable dispatch now blocks on a provisioner run it previously never triggered.
- A provisioning failure now refuses the dispatch instead of silently starting an agent with an empty shadow.

---

## Decision

**Chose**: Option B — shared, lockfile-keyed, read-only volumes resolved host-side, through the same resolver every other eligible dispatch shape already uses. Per-dispatch copies (Option A) were rejected specifically because they would have solved a problem read-only-ness already solves, at the cost of inventing infrastructure this codebase has deliberately never built.

It carries three commitments worth stating plainly, because each one is the actual lesson of this ticket and none of them is inferable from reading the diff cold.

### Decision 1 — the fix is keyed to two gates, and moving only one produces a change that looks shipped and fixes nothing

Reaching the mount required moving **both**:

- the resolve gate in `src/v2/invoke.ts`, which previously ran `prepareDependencyEnvironmentForDispatch` only under `if (args.readOnlyProject)`, and
- the mount planner in `src/v2/spawn.ts`'s `buildDockerArgs`, whose read-write arm additionally required `ctx.IS_WORKTREE_DISPATCH === "1"` before it would honor `DEPENDENCY_CACHE_MOUNT_RO`.

Moving only the resolve gate produces a dispatch that resolves an environment, writes a receipt into the manifest, sets `DEPENDENCY_CACHE_MOUNT_RO`, and **still falls through to the anonymous shadow**, because the planner's rw arm was gating on worktree-ness, not on whether an environment had actually been resolved. That shape — a receipt on record for a mount that never happened — is worse than the original hole, because it reads as fixed. This is the most reusable lesson in the change: a host-side resolution and a container-side mount decision are two separate gates, and a fix that closes only the one that's easier to find (the call site) leaves the one that's easier to miss (the mount planner) exactly as broken as before.

The corrected planner drops `IS_WORKTREE_DISPATCH` from the gate entirely and keys the named-volume arm on `DEPENDENCY_CACHE_MOUNT_RO === "1"` alone — set only by a caller that actually resolved an environment. `IS_WORKTREE_DISPATCH` survives as a diagnostic (worth knowing which shape dispatched, when reading a task back) but decides nothing.

The consequence of gating on shape rather than on entrypoint: this is keyed to "rw dispatch, no worktree," not to `forge invoke`. A workflow dispatch with `FORGE_NO_WORKTREES=1`, or one whose tree simply isn't mountable as a worktree, lands in `runNext.ts`'s new `else if (dependencyCacheEligible && args.projectMode === "rw" && !isWorktreeRwDispatch)` arm and is covered by the identical mechanism, not a parallel one built for the CLI entrypoint specifically.

### Decision 2 — a project that declares dependencies with no supported lockfile is refused, on both lanes, and this is the actual decision here

The resolver's discriminator is three-way, not two-way:

1. **No declared dependencies** — not applicable. Dispatches exactly as before; never refused on this ground.
2. **Declared dependencies, with a supported lockfile (`package-lock.json`)** — resolves.
3. **Declared dependencies, with no supported lockfile** — refused, `lockfile_absent`, before any container starts.

The old two-way check (`cacheKey === undefined` → not applicable) conflated the second and third cases: "no lockfile" used to mean "nothing to provision" regardless of whether the project's own `package.json` declared dependencies it needed. That is the falsehood that let a writable dispatch be handed an empty, unkeyed workspace and left to improvise.

The refusal lives in the **one shared resolver**, so it reaches the read-only reviewer lane too — this is the actual operator-facing decision, not an incidental side effect. A project declaring dependencies without a supported lockfile has no deterministic dependency environment, and that is equally true whether the caller is a writable implementer or a read-only reviewer. Letting the reviewer lane through on the old two-way check would have preserved the exact silent-verification defect FG-664's read-only gate was built to close — a reviewer running against whatever the `:ro` project bind happened to expose, with no attested environment behind it. The consequence is honest and stated plainly: a darwin read-only reviewer against a project with declared, unlockfile-keyed dependencies now **refuses where it previously dispatched**. It is bounded by the two escape hatches that run ahead of the discriminator — non-darwin hosts and `FORGE_NO_NM_SHADOW=1` — both of which still return `not_applicable` for every project, lockfile or not.

Supporting an intentionally lockfile-less project is a possible **future, explicit** opt-out. It must never become an implicit degraded path — that shape (a quiet fallback standing in for a decision nobody made) is precisely what this gate exists to eliminate.

### Decision 3 — the anonymous shadow was never the defect; its emptiness was

The `node_modules` shadow mask in `spawn.ts`'s rw arm — the thing that makes the container-local mount win over whatever the read-only project bind carries at the same path — survives in every arm, including the ones this ticket rewired. Unmasking it so a host-side install could reach the container was never on the table: that would put a container-side `npm ci` (or any container-side write) onto the operator's live tree, through the read-write project bind, and `docker/agent-entrypoint.sh`'s install step would delete and rebuild the `better-sqlite3` binding the running orchestrator and every concurrent host `forge` process are loaded from — the same self-host hazard `docs/concepts.md`'s self-host refusal already exists to prevent, just reached through a different door. The defect this ticket fixes was that the shadow **started empty and stayed empty**, not that a mask exists. What sits behind the mask changed — an attested, lockfile-keyed, read-only volume instead of nothing — never whether the mask itself is there.

**Rationale**: Option A (per-dispatch copies) would have bought isolation the platform already gets for free from `:ro` mounts, at the cost of building a volume lifecycle this codebase has specifically declined to build (see `removeDependencyVolumes`'s worktree scoping and the note in `worktree-lifecycle.ts` about why it isn't called per task). Option B costs nothing new mechanically — it is a third caller of an existing resolver, gated by an existing mount planner, refused by an existing failure kind — and its only real costs (cold-cache latency, a new pre-container failure mode on a lane that previously couldn't fail before starting) are the same costs FG-664 already accepted for the reviewer lane, for the same reason: a visible refusal beats a verdict, or a validation, nobody can trust.

---

## Consequences

**Positive**:

- A writable `forge invoke` and a non-worktree workflow rw dispatch now get the project's real, attested dependencies instead of an empty mask — the defect the two diverging `test-engineer` dispatches demonstrated cannot recur on this lane.
- The dependency contract is now uniform across all three dispatch shapes (read-only, worktree-rw, non-worktree-rw), through one resolver and one mount planner — "which shape dispatched" no longer decides "does this dispatch get its dependencies," only how the resolved environment is diagnosed after the fact.
- An agent's own declared failure (`result.json` with `status: "failed"`) is now honored at the ingestion seam in `invoke.ts` rather than silently completing the task row — the second half of what let the original defect hide: an agent that reported it could not execute anything used to still land a `complete` row.
- `dispatchRefused.reason` gains `lockfile_absent`, so an unkeyable project is refused with a diagnosis naming the manifest and the remedy, on either lane.

**Negative / Trade-offs**:

- A cold-cache writable dispatch now blocks on a provisioner run it never triggered before.
- A provisioning failure, or an unsupported-lockfile project, now refuses a writable dispatch pre-container where it previously started (with no dependencies, silently).
- A darwin read-only reviewer against a declared-dependencies-no-lockfile project now refuses where it previously dispatched — an operator-visible behavior change on the reviewer lane, caused by fixing the writable lane through the shared resolver.
- `agent_reported_failure` is deliberately broad: it changes outcome reporting for every invoke role, including reds, research, and architect dispatches — not just implementers.

**Risks**:

- **The two-gate lesson gets forgotten on a future change to either file.** A change that touches only `invoke.ts`'s resolve call or only `spawn.ts`'s mount planner, without checking the other, reproduces the exact "looks fixed, changes nothing" shape this ticket found and closed. Mitigated by stating it here and in both files' comments.
- **`lockfile_absent` gets read as punitive** rather than as the same silent-verification defect FG-664 already fixed once. Mitigated by recording, here, that letting either lane dispatch unkeyed was the actual hazard, not a stricter posture for its own sake.
- **A future "convenience" unmasks the shadow** to let a container install fall back onto the host tree when the host-side resolution is slow or unavailable. That is the self-host hazard restated — mitigated by naming it explicitly as Decision 3 above.

---

## Implementation Notes

- **Do not gate the mount planner's rw arm on `IS_WORKTREE_DISPATCH` again.** It is a diagnostic field now, not a decision input. The gate is `DEPENDENCY_CACHE_MOUNT_RO === "1"`, set only by a caller that actually resolved an environment through `prepareDependencyEnvironmentForDispatch`.
- **A resolve-gate change is not a fix on its own.** Any future change to which dispatches call `prepareDependencyEnvironmentForDispatch` (in `invoke.ts` or `runNext.ts`) must be checked against `spawn.ts`'s `buildDockerArgs` mount planner in the same review — the two must agree on which shapes get the named volumes, or the receipt and the mount can disagree.
- **Never unmask the `node_modules` shadow.** The mask is load-bearing host safety, not a workaround. See `docker/agent-entrypoint.sh` and the self-host refusal recorded in `docs/concepts.md`.
- **`lockfile_absent` is decided from the manifest read alone, before any provisioner or probe container runs** — it is the cheapest of the seven refusal reasons to reach, by design, because there is nothing to provision toward.
- **Do not add an implicit degraded path for lockfile-less projects.** If intentionally lockfile-less projects need to be supported, that is a new, explicit, named opt-out — never a fallback that silently narrows what "resolved" means.
- Read FORGE-DEC-004, FORGE-DEC-005, FORGE-DEC-006 and FORGE-DEC-009 — the decisions `CLAUDE.md` names as prerequisites for touching the Docker invocation pattern in `spawn.ts` — before editing that file further, in addition to FORGE-DEC-019 (`2026-06-04_node-modules-shadow-volume.md`) and FORGE-DEC-030 below.

**Prior decisions this one leans on**:

- FORGE-DEC-019 — `2026-06-04_node-modules-shadow-volume.md`. The `node_modules` shadow mask this decision reuses and never unmasks.
- FORGE-DEC-030 — `2026-08-02_reviewer-dependency-environment.md` (FG-664). The read-only dependency-environment gate, resolver, provisioner, lock, and probe this decision extends to a third dispatch shape rather than reimplementing.
- FG-376 (`docs/concepts.md` → Agent worktree dependency parity). The worktree-mode named-volume mechanism and its lock/provisioner semantics, deliberately worktree-only when written — this decision is the generalization that FG-376 itself did not attempt.

---

## Revisit Conditions

- If a future dispatch shape appears that mounts a project directory but is neither read-only nor covered by `isWorktreeRwDispatch` / the new non-worktree-rw arm, it needs to be evaluated against this same resolver before it ships — not given a fourth bespoke path.
- If intentionally lockfile-less projects become a real, requested use case, the answer is a new named opt-out evaluated on its own, not a loosening of `lockfile_absent`.
- If cold-cache provisioner latency on the writable lane becomes the dominant cost of a dispatch, the answer is an operator pre-warm verb (already an open gap noted in FORGE-DEC-030), not relaxing the refusal.
