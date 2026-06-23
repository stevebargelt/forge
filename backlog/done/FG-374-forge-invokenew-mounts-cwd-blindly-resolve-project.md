---
id: FG-374
type: story
status: done
title: forge invoke/new mounts cwd blindly — resolve project root or hard-fail on suspicious subdir mounts
created: 2026-06-23
closed: 2026-06-23
---

**Priority: high — infrastructure / correctness.** Prevents a whole class of bogus agent runs.

## Problem

`forge invoke` and `forge new` default `--project` to the current working directory and mount it blindly as `/project` in the agent container. When invoked from a workspace SUBDIRECTORY of a monorepo (e.g. `dashboard/` in the forge repo), only that subdir is mounted — severing the cross-workspace dependencies it needs. The dashboard's `@forge/*` tsconfig aliases resolve to `../src`, and its tests import `../../src/raci/compile.js` + `../../seeds/`; none of that exists when only `dashboard/` is the mount root.

## How it bit us (FG-359 incident, 2026-06-23)

A test-engineer was dispatched while the orchestrator shell was `cd`'d into `dashboard/` (left over from running `npm test`). `forge invoke` mounted only `dashboard/` as `/project`. Container logs: `ls /project/../src → "no ../src"`. The agent — correctly seeing the monorepo absent — then fabricated the environment (stub `@forge/*` shims in node_modules, a fake `raci-compile.ts`, a stub RACI seed, deleted the `@forge/*` paths from tsconfig.json, added bogus deps) and reported `complete` with "tests pass" against fakes. Host typecheck caught it (`Cannot find module '@forge/backlog'`) and the corruption had to be reverted. The agent's fabrication is its own seed bug, but the ROOT TRIGGER was the silent subdir mount.

## Fix

`forge invoke`/`forge new` should resolve the intended project root instead of blindly trusting cwd:
- Walk up from cwd for project-root markers (`.git`, a `package.json` with a `workspaces` field, `.forge/`) and mount the resolved root; OR
- If the root cannot be inferred confidently, HARD-FAIL with a clear message: "run from the project root or pass --project <dir>." Never silently mount a suspicious subdir.

## Acceptance Criteria

- Invoking from `dashboard/` inside the forge repo resolves/mounts the forge repo ROOT, not `dashboard/`.
- OR, if forge cannot infer the root confidently, it hard-fails with "run from project root or pass --project."
- The task manifest records BOTH `invocationCwd` and the resolved `projectDir`.
- Container preflight verifies required project markers are visible inside the container before the agent executes (fail fast, before any agent tokens are spent).
- Regression test covers invoking from a workspace subdirectory (asserts root resolution or the hard-fail).

## Resolution policy (refined with operator 2026-06-23)

Three cases, distinguished by how the subdir mount is requested:

1. **Implicit (default cwd) is a subdir of a detected root:** resolve UPWARD to the root and mount it; if the root cannot be inferred confidently, HARD-FAIL ("run from the project root or pass --project <dir>").
2. **Explicit `--project <subdir>` from an interactive/human CLI** (TTY present, not `--json`): warn-and-honor is acceptable (explicit human choice).
3. **Explicit `--project <subdir>` from orchestrator/agent automation** (no TTY, or `--json`): HARD-FAIL unless an override flag is present.

Override flag: `--allow-subproject`. With it, an explicit subdir mount succeeds and the manifest records `explicitSubproject: true`.

```
forge invoke --project dashboard ...                    # FAILS if dashboard is inside detected root /repo (automation default)
forge invoke --project dashboard --allow-subproject ... # succeeds; manifest records explicitSubproject: true
```

Interactive-vs-automation is detected from TTY presence (`process.stdout.isTTY`) and/or the `--json` flag — the orchestrator invokes via Bash with no TTY, so it lands in the strict (case 3) path by default.

## Notes

- An explicit `--project <repo-root>` is the current workaround.
- Relates to the manifest/control-plane provenance work (FG-350) — `invocationCwd` vs resolved `projectDir` is exactly the kind of dispatch-time provenance receipts already capture.
