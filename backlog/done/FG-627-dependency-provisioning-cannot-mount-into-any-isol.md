---
id: FG-627
type: story
status: done
title: Dependency provisioning cannot mount into any isolated workspace — the deps volume mountpoint cannot be created under a read-only /project
created: 2026-07-27
closed: 2026-07-27
closed_commit: "8714232"
---

**Found by the FG-621 dogfood (2026-07-27) — the first real end-to-end isolated dispatch forge has
ever run.** Blocks FG-621 AC 11 and FG-345 default-on.

## What happens

A real pipeline dispatch under `FORGE_WORKTREES=1` provisioned the private clone correctly — the
task row records `worktree_path=~/.forge/worktrees/clones/<runId>/<taskId>` and
`base_sha=3b42035e45bb` — and then died before any agent container started:

```
verification_environment_unavailable: dependency install failed (provisioner exit 125) —
docker: Error response from daemon: ... error mounting
"/var/lib/docker/volumes/forge-deps-5f33f1ce08f5973b-root/_data" to rootfs at "/project/node_modules":
create mountpoint for /project/node_modules mount:
mkdirat .../project/node_modules: read-only file system
```

## Mechanism

`buildProvisionerDockerArgs` mounts the project READ-ONLY (`src/v2/spawn.ts:1011`,
`${PROJECT_DIR}:${projectContainerPath}:ro`) and mounts the lockfile-keyed dependency volume at
`${projectContainerPath}/node_modules`. Mounting a volume at a path inside a read-only bind requires
the mountpoint DIRECTORY to already exist in the source; docker cannot `mkdir` it on a read-only
rootfs.

A main checkout has `node_modules` physically present, so the mountpoint exists and this works —
which is why it has never been seen. **No isolated workspace has it.** `node_modules` is gitignored,
so neither a fresh `git clone --shared` nor a fresh `git worktree add` ever contains that directory.

## Scope: this is almost certainly NOT clone-specific

Reasoned, not yet measured: a linked worktree is equally empty of `node_modules`, so the worktree
path should fail identically. If so this is a latent defect in the FG-376 provisioning contract that
predates FG-621 and has simply never been exercised, because isolation has always been default-off
and blocked. **Measure this before fixing** — a `FORGE_WORKTREES=1` dispatch on a build of forge
without the clone substrate answers it directly, and the answer decides whether the fix belongs in
the provisioner contract generally or in workspace creation.

Note FG-621's AC 8 was proven at PLAN level only (`planDependencyVolumes` resolves an identical
lockfile hash and volume-name set for clone, worktree and main checkout — `fg621-clone-dependency-
parity.worktree.test.ts`). That test is correct about what it asserts and says so; it does not, and
was not written to, prove the volume actually MOUNTS. The gap between "the plan is identical" and
"the mount succeeds" is exactly this defect.

## Fix direction (not prescriptive)

Candidates, each with a different blast radius:
- create the mountpoint directory in the workspace at creation time (workspace-creation fix; keeps
  the provisioner's read-only project mount intact, which is a real safety property);
- mount the project read-write for the provisioner only (weakens a boundary — least attractive);
- mount the dependency volume somewhere outside the project tree and link/redirect (changes the
  DEC-019 shadow-volume contract).

Whichever is chosen must keep the provisioner's project mount read-only if at all possible: the
provisioner exists to populate a cache, not to write the project.

## Acceptance criteria

1. A real `FORGE_WORKTREES=1` pipeline dispatch on a project whose workspace has no `node_modules`
   provisions dependencies and starts its agent container.
2. The provisioner's project mount stays read-only, or the change explains why it cannot.
3. Proven end-to-end by a real dispatch, not by a plan-level assertion — the gap this ticket exists
   to close is precisely that a correct plan does not imply a successful mount.
4. Established first: whether the linked-worktree substrate fails identically, recorded in this
   ticket either way.
5. `forge-test` green; required CI checks green.

Refs: FG-376 (dependency volumes + `verification_environment_unavailable`), FG-621 (AC 8 plan-level
parity; the dogfood that surfaced this), FG-345 (default-on, blocked by this), DEC-019 (node_modules
shadow volume), `src/v2/spawn.ts:1011`.

## AC 4 answered — the linked-worktree substrate fails identically

Established before the fix, as AC 4 requires. **Yes — the defect is substrate-general, not
clone-specific.** Two independent confirmations:

- `src/v2/runNext.ts:3225` sets `repoRootForMount = args.worktreePath ?? args.projectDir`, and that
  value is what becomes `PROJECT_DIR` for the provisioner (`:3254`) and the read-only project mount.
  Both substrates therefore present the *isolated workspace* as the mount source; neither presents
  the main checkout.
- `node_modules` is gitignored, so neither `git worktree add` nor `git clone --shared` materializes
  it. A fresh worktree and a fresh clone are both empty of it, so on both the provisioner asks docker
  to bind a volume at a path that does not exist inside a read-only rootfs.

**Consequence for the fix, and why it landed where it did:** this is a latent FG-376 provisioning
defect that predates FG-621's clone substrate and had simply never been exercised, because isolation
has always been default-off. The fix therefore belongs to workspace creation *generally*, not to the
clone path — `createDependencyMountpoints` is called from both
`src/v2/worktree-lifecycle.ts:215` (linked worktree) and `:372` (private clone), and derives its
directory set from `planDependencyVolumes` so it cannot drift from what `spawn.ts` actually mounts.

## Acceptance Evidence

| AC | Evidence | Verdict |
|----|----------|---------|
| 1. A real `FORGE_WORKTREES=1` pipeline dispatch on a project whose workspace has no `node_modules` provisions dependencies and starts its agent container. | Run `run-fg-566-review-loop-fresh-clone-verification-readiness-dogfood-693dbc`, task `task-architect-824e5d`, at `base_sha 871423232dbcd279c189fd1e6f9e4f945f38a156` in the isolated clone `~/.forge/worktrees/clones/run-…-dogfood-693dbc/task-architect-824e5d`. Durable event chain: `container.provision_started` 15:51:37 → `container.provision_succeeded` 15:51:40 → `container.started` 15:51:41 → `container.exited` 16:03:10, `container evidence: confirmed container exit (forge-task-architect-824e5d) — exit code 0, OOMKilled=false`. The agent produced a complete architect artifact. Pre-fix this same path died at provisioner exit 125 with `mkdirat …/project/node_modules: read-only file system`. The task's later `failed` status is the FG-357 integration gate failing on the *publication candidate* worktree — a different workspace and the separate FG-566 defect, downstream of everything this ticket owns. | met |
| 2. The provisioner's project mount stays read-only, or the change explains why it cannot. | `src/v2/spawn.ts:1011` still mounts the project with the `:ro` suffix (`${ctx.PROJECT_DIR}:${projectContainerPath}:ro`) — unchanged. The merged diff (`8714232`) touches only `src/v2/dependency-provisioning.ts`, `src/v2/worktree-lifecycle.ts` and a new test; `spawn.ts` is not in it. The workspace-creation fix was chosen precisely to preserve this boundary. | met |
| 3. Proven end-to-end by a real dispatch, not by a plan-level assertion. | Same live run as AC 1 — a real pipeline dispatch that provisioned and started a container, not a `planDependencyVolumes` assertion. This closes the gap FG-621 AC 8 explicitly left open ("the plan is identical" vs "the mount succeeds"). | met |
| 4. Established first: whether the linked-worktree substrate fails identically, recorded in this ticket either way. | Recorded above under *AC 4 answered*: it fails identically. `src/v2/runNext.ts:3225` (`repoRootForMount = args.worktreePath ?? args.projectDir`) plus `node_modules` being gitignored on both substrates. Acted on in the fix: `createDependencyMountpoints` is invoked from `worktree-lifecycle.ts:215` (worktree) and `:372` (clone), with per-substrate regression cases in `src/v2/fg627-workspace-dependency-mountpoints.worktree.test.ts` — "a fresh linked worktree carries a mountpoint for every planned dependency volume" (:108) and "a fresh private clone carries a mountpoint for every planned dependency volume" (:125), plus a both-substrates cleanliness case (:138) and a no-lockfile no-op case (:155). | met |
| 5. `forge-test` green; required CI checks green. | PR #165, all nine checks green at the merged head: `test` pass 52s, `test-extended` pass, `worktree` pass 1m3s, `dashboard_integration` pass 18s, `integration_1`–`integration_5` all pass (Actions run 30281492888). Merged as `8714232`. | met |
