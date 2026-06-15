---
id: FG-111
type: story
status: done
title: Verify phase blocked by native-module mismatch
---

**Closed:** 2026-05-12 on branch `verify-container-111` → merged to main as `da06410`. Test suite 328/328 passes inside the agent container, matching host. Shipped:
- `docker/forge-test.sh`: wrapper that copies `/project` to `/tmp/forge-work`, rebuilds `better-sqlite3` for the container platform, runs tests there. ~30s overhead per container; host's `/project` is never mutated (works under `:ro` mount too — reds can now run tests).
- `docker/agent-dev-worker.Dockerfile`: bakes the wrapper at `/usr/local/bin/forge-test`. `build-essential` + `python3` were already present so no other prereqs needed.
- `docker/.dockerignore`: allows `forge-test.sh` into the build context.
- `seeds/agents/verifier/CLAUDE.md`: documents `forge-test` usage and the platform-mismatch rationale, replacing the previous "agent figures out testing" looseness that produced #91's diagnostic-only verify behavior.
**Approach taken:** option 1 from the original entry (rebuild in container) — chosen over per-platform `node_modules` volumes (option 2) or swapping the SQLite binding (option 3). Cost: ~30s per container, acceptable.
**Unblocks:** #109 (transactional reconcile + fault-injection tests).