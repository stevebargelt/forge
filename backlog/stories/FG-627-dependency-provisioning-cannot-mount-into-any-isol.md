---
id: FG-627
type: story
status: active
title: Dependency provisioning cannot mount into any isolated workspace — the deps volume mountpoint cannot be created under a read-only /project
created: 2026-07-27
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
