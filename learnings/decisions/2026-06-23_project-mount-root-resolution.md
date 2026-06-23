# Decision: Resolve project mount root on invoke/new; hard-fail on suspicious subdir mounts

**ID**: FORGE-DEC-022
**Date**: 2026-06-23
**Status**: Decided
**Decided by**: Steven
**Supersedes**: N/A (reverses an earlier implicit design choice — see Context)
**Scope**: forge

---

## Context

`forge invoke` and `forge new` previously mounted the cwd (or the `--project <dir>` value) directly as `/project` in the agent container, without checking whether that path was a subdirectory of a larger monorepo. Project *identity* (run name, rollup under one project) used the git root via `findGitRoot()`, but the *mount target* was deliberately kept at cwd.

The earlier choice was intentional: `src/util/git-root.ts` carried an explicit comment that the mount was kept at cwd while only identity used the repo root. The reasoning at the time was that an operator passing `--project <subdir>` had explicitly chosen that scope.

This decision reverses that choice for the default (implicit) case and hardens the explicit case.

Relevant architecture: DEC-004 — orchestrator runs on the host; agents run inside Docker containers whose `/project` bind mount is the sole window into the codebase. If the wrong directory is mounted, the agent has no way to detect or correct it; it either fails confusingly or, worse, fills in the gaps itself.

---

## Problem

When the orchestrator shell is `cd`'d into a monorepo subdirectory (e.g. `dashboard/` inside the forge repo), `forge invoke` silently mounts only that subdirectory. Cross-workspace dependencies (`../src`, `../../seeds/`, `@forge/*` tsconfig aliases) are absent from `/project`. The agent has no `../src` to import from.

**FG-359 incident (2026-06-23):** A test-engineer agent was dispatched while the orchestrator shell was in `dashboard/`. Container logs showed `ls /project/../src → "no ../src"`. Rather than failing, the agent fabricated the environment: stub `@forge/*` shims in node_modules, a fake `raci-compile.ts`, stub RACI seeds, deleted `@forge/*` from tsconfig paths, added bogus deps. It then reported `complete` with "tests pass" against the fakes. The host typecheck caught it (`Cannot find module '@forge/backlog'`), but the corruption had to be manually reverted. The root trigger was the silent subdir mount.

---

## Decision

Implement a 3-case resolution policy in `src/util/resolve-project-mount.ts` (`resolveProjectMount()`), called by both `forge invoke` and `forge new` before any container is launched.

### Case 1 — base is NOT inside any git repo

Mount `base` unchanged. Behavior is identical to before. No output, no change to `projectDir`.

### Case 2 — implicit invocation (no `--project`), base IS a subdir of a detected root

Walk up to the git root. If the root has a confident project marker (`.git` + `.forge`, or `.git` + `package.json`), resolve up and mount the root. Print an informational notice:

```
forge: resolved project root: /repo (invoked from /repo/dashboard)
```

If no confident root can be identified (git root found but no `.forge` or `package.json`), **hard-fail**:

```
run from the project root or pass --project <dir>
```

This avoids blindly resolving to an unrelated git root in nested-checkout scenarios.

### Case 3 — explicit `--project <subdir>` where subdir is inside a detected root

Three sub-cases, distinguished by context:

| Context | Behavior |
|---|---|
| `--allow-subproject` present | Honor the subdir mount; set `explicitSubproject: true` in manifest |
| Interactive TTY, not `--json` | Warn and honor (human made an explicit choice) |
| No TTY, or `--json` (automation) | **Hard-fail** with guidance to pass `--allow-subproject` or use the root |

The automation hard-fail error message:

```
--project <subdir> is a subdirectory of <root>; pass --allow-subproject to mount it intentionally, or --project <root>.
```

Interactive warning:

```
forge: WARNING — --project <subdir> is inside repo <root>; mounting the subdir — cross-workspace deps may be missing
```

Interactive/automation boundary is detected from `process.stdout.isTTY` and the `--json` flag. The orchestrator invokes forge via Bash with no TTY, so it lands in the strict (hard-fail) path by default.

---

## Escape hatch: `--allow-subproject`

Both `forge invoke` and `forge new` add `--allow-subproject`. With it:
- Case 3 (explicit `--project <subdir>`) succeeds unconditionally.
- The task manifest records `explicitSubproject: true`, making the intentional override auditable.
- Case 2 (implicit subdir) is **not** affected — `--allow-subproject` only applies when `--project` was also passed.

---

## Spawn preflight

`src/v2/spawn.ts` adds `preflightProjectMount(projectDir)`. Called just before `docker run` on **both** the `forge invoke` path (`src/v2/invoke.ts`) and the `forge new` workflow path (`src/v2/runNext.ts` → `runContainer`), it hard-fails only when the path does not exist or is not a directory. An empty directory or a directory with no `.git` or `package.json` emits a `console.warn` and passes — forge supports non-git/non-npm project layouts (and tests use bare `mkdtemp` directories).

| Condition | Outcome |
|---|---|
| Path does not exist | hard-fail (throws) |
| Path is not a directory | hard-fail (throws) |
| Directory is empty | `console.warn`, passes |
| No `.git` or `package.json` | `console.warn`, passes |

The `forge new` (workflow) path now has full parity on manifest fields as well: `invocationCwd`, `resolvedFromSubdir`, and `explicitSubproject` are stored in run metadata at `startRun` time and threaded into each task's control-plane receipt by `runNext`.

---

## Manifest fields (FG-350 control-plane receipt)

Three new optional fields added to `ControlPlaneReceipt` in `src/v2/task-manifest.ts`:

| Field | Type | Meaning |
|---|---|---|
| `invocationCwd` | `string` | Directory forge was invoked from; may differ from `projectDir` when resolved from a subdir |
| `resolvedFromSubdir` | `boolean` | True when `projectDir` was resolved upward from a subdir (case 2) |
| `explicitSubproject` | `boolean` | True when `--allow-subproject` was passed to honor an explicit subdir mount (case 3) |

Also added to `StartRunArgs` (via `startRun.ts`) and recorded in run metadata as control-plane keys (stripped from task inputs; cannot be set via `--meta`).

---

## Rationale for hard-failing in automation

A warning in automation is unsafe: the orchestrator reads exit code 0, proceeds, and the agent runs in a broken environment. The FG-359 agent didn't fail — it fabricated. A hard fail before any container is started is the only behavior that surfaces the misconfiguration before tokens are spent.

Interactive TTY + human use case is different: the human typed `--project dashboard/` deliberately and saw the warning. Honoring their choice (with a warning) is acceptable. Automation must always be explicit about deviations.

---

## Consequences

**Positive**:
- A whole class of "agent ran in the wrong directory" bogus runs is eliminated at the dispatch layer, before any agent tokens are spent.
- Implicit invocations from monorepo subdirs now just work — the user does not need to `cd ..` first.
- The mount target and the project identity now agree for implicit invocations (both are the repo root), removing the mount≠identity asymmetry that was the latent cause of FG-359.
- `invocationCwd` / `resolvedFromSubdir` in the manifest make the resolution decision auditable.

**Negative / Trade-offs**:
- Operators who deliberately passed `--project <subdir>` in automation pipelines will now get a hard-fail. They must add `--allow-subproject` to their invocation. One-time migration cost.
- Interactive subdir invocations without `--project` now resolve up silently (with a notice). If an operator specifically wanted to target only the subdir, they must pass `--project <subdir> --allow-subproject`.

**Risks**:
- A git repo with no `.forge` or `package.json` at root triggers a hard-fail on implicit subdir invocations. Bare or unconventional repos may need an explicit `--project <root>` until they add a marker.

---

## Implementation Notes

- `resolveProjectMount()` is a pure function (cwd injectable); test it with synthetic directory fixtures, not process.cwd(). See `src/util/resolve-project-mount.test.ts`.
- `findGitRoot()` returns `startDir` unchanged when no `.git` ancestor is found — so `isSubdir = (root !== base)` correctly handles non-git directories as case 1.
- `new.ts` has no `--json` flag; the `json: false` hardcode in its `resolveProjectMount` call is intentional — interactive vs automation is TTY-only for `forge new`.
- The `--allow-subproject` description in the Commander option is intentionally brief (`FG-374: intentionally mount a subdir of a git repo (normally an error in automation)`) — a full explanation belongs in this ADR, not in `--help` output.

---

## Revisit Conditions

- **Bare git repos become common targets.** If operators frequently target git repos with no `.forge` or `package.json`, the "confident root" check in case 2 is too strict. Consider accepting `.git` alone, or adding a `--project-root` flag that bypasses the confidence check.
- **Nested monorepos.** If a project contains nested git repos (submodules), `findGitRoot` finds the innermost `.git`. The current policy is correct for that shape, but test explicitly if nested-submodule support is ever a requirement.
