---
id: FG-628
type: story
status: active
title: Reviewer dispatch crashes on any project directory missing a workspace-member node_modules — FG-627's mountpoint fix never covers the non-isolated path
created: 2026-07-27
---

**Found live 2026-07-27** during the FG-566 architect phase (`run-fg-566-shared-host-side-verification-readiness-contract-0f7edc`), with isolation **OFF**. Both architect reds died before starting, and their verdicts were ingested as non-blocking `inconclusive (0.00)` — so the gate opened with **no adversarial review having run at all**. Silence read as success.

## What happens

```
docker: Error response from daemon: failed to create task for container: ... runc create failed:
error mounting "/var/lib/docker/volumes/forge-deps-5f33f1ce08f5973b-dashboard/_data"
to rootfs at "/project/dashboard/node_modules":
create mountpoint for /project/dashboard/node_modules mount:
mkdirat .../project/dashboard/node_modules: read-only file system: unknown
```

Tasks: `task-red-architect-da8b83` and `task-red-architect-82a680`, both `container_crash (exit 1)`,
both at the same second they were created. The project was `~/code/forge-fg356` — an ordinary
checkout with a populated **root** `node_modules` and **no** `dashboard/node_modules`.

## Mechanism — why the primary survived and only the reds died

`src/v2/spawn.ts` mounts the dependency cache through three different branches, and only some of them
use the multi-volume plan:

- **`projectMode === "rw"` without worktree dispatch** (`spawn.ts:871`) — the architect's path. Falls
  back to a single legacy anonymous volume at `/project/node_modules`. That directory exists in any
  checkout that has ever been installed, so it always works. **The primary agent never exercises the
  multi-volume path on a non-isolated dispatch.**
- **`projectMode === "ro"` with `DEPENDENCY_CACHE_MOUNT_RO=1`** (`spawn.ts:881`) — the reviewer/red
  path. Calls `planDependencyVolumes` and mounts **every planned member volume** read-only, including
  `forge-deps-<hash>-dashboard` at `/project/dashboard/node_modules`.

`package.json` declares `workspaces: ["dashboard"]`, so the plan always contains a dashboard member.
Mounting a volume at a path inside the read-only `/project` bind requires the mountpoint directory to
**already exist in the source**; docker cannot `mkdir` on a read-only rootfs. A checkout that ran a
root-only install — or any checkout where the member was never installed — does not have it.

So the failure is reachable on a completely ordinary, non-isolated project directory, and it
selectively kills **reds and reviewers** while letting the primary through.

## Relationship to FG-627 — this is the uncovered half

FG-627 fixed exactly this docker behavior, but only at **isolated-workspace creation**:
`createDependencyMountpoints` is called from `worktree-lifecycle.ts:215` (linked worktree) and `:372`
(private clone). Neither runs when isolation is off, so a plain `--project <dir>` dispatch gets no
mountpoints created.

FG-627's premise sentence was *"A main checkout has `node_modules` physically present, so the
mountpoint exists and this works."* That is true for the **root** member and false for **every other
workspace member**. FG-627 is correctly scoped and correctly closed; this is the case its premise
excluded, measured rather than reasoned.

## Why this is more than a papercut

The reds' crash is not surfaced as a review failure. `forge show` reports:

```
Verdicts:
  - red-wide (specialist):   inconclusive (0.00) — task-red-architect-da8b83
  - red-narrow (specialist): inconclusive (0.00) — task-red-architect-82a680
```

`inconclusive` is non-blocking, so the phase advanced to `awaiting_gate` and an orchestrator that
trusted the gate would advance a phase whose adversarial review never executed. A red that could not
**start its container** is a different fact from a red that reviewed and could not decide, and the
current ingestion cannot tell them apart.

## Acceptance criteria

1. A dispatch against a project directory whose workspace member lacks `node_modules` starts its
   reviewer/red containers successfully — reproduced RED against current behavior first, using a
   checkout with a root-only install.
2. The fix covers the **non-isolated** path. Whatever creates the mountpoints must run for a plain
   `--project <dir>` dispatch, not only at isolated-workspace creation. Reuse
   `createDependencyMountpoints` rather than adding a second mechanism — it already derives its set
   from `planDependencyVolumes` so it cannot drift from what `spawn.ts` mounts.
3. The provisioner's and reviewer's project mounts stay read-only (`spawn.ts:1011`, and the `:ro`
   suffix on every planned member volume).
4. Creating mountpoints in a **live, non-disposable** checkout is safe and reversible: empty
   directories are invisible to git including `status --porcelain --ignored`, but state explicitly
   whether anything else (the FG-356 reaper's unrecovered-work probe, `npm`'s own workspace
   resolution, editor/tooling watchers) is affected by an empty member `node_modules` appearing in
   an operator's working checkout. If it is not safe there, the fix belongs at dispatch preflight
   with an explicit refusal instead.
5. **A red that never started its container must not ingest as a non-blocking `inconclusive`.**
   Container-crash-before-start is an infrastructure failure, not a review outcome; it must block the
   gate or surface distinctly enough that an orchestrator cannot mistake it for "reviewed, undecided".
   Assert both halves: the crash case blocks/surfaces, and a genuine reviewed-but-undecided verdict
   still ingests as `inconclusive` exactly as today.
6. `forge-test` green; required CI checks green.

## Immediate workaround applied

`mkdir -p ~/code/forge-fg356/dashboard/node_modules` unblocked the FG-566 run. The dependency volume
`forge-deps-5f33f1ce08f5973b-dashboard` is itself empty (0 entries), which is harmless for an
artifact-reviewing red but worth noting: the reviewer path mounts a cache that the non-isolated
primary path never populates.

Refs: FG-627 (isolated-workspace mountpoints — the covered half), FG-376 (dependency volumes,
`planDependencyVolumes`, `verification_environment_unavailable`), `src/v2/spawn.ts:845-895`,
`src/v2/dependency-provisioning.ts:167`, `src/v2/worktree-lifecycle.ts:215,372`. Red-ingestion half
is adjacent to the `runNext.ts:691` downgrade behavior already recorded for unsubstantiated fails.
