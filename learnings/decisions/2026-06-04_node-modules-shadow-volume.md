# Decision: Shadow-mount node_modules with a container-local anonymous volume on macOS

**ID**: FORGE-DEC-019
**Date**: 2026-06-04
**Status**: Decided — supersedes FORGE-DEC-011
**Decided by**: Steven (forge build, closed #245)
**Supersedes**: FORGE-DEC-011 (`2026-05-06_docker-mount-corrupts-native-binary.md`)
**Scope**: forge

---

## Context

FORGE-DEC-011 documented (without a code fix) that on macOS, Docker Desktop's **grpcfuse** filesystem layer stamps a `com.docker.grpcfuse.ownership` extended attribute on native binaries the container writes through the bind mount (e.g. `better-sqlite3.node`). CyberArk-class EDR then silently SIGKILLs the HOST Node processes that load those binaries (exit 137, no stderr). Recovery was a manual `npm install` to replace the poisoned binary.

A second, independent problem surfaced during a forge-site run: the rw project bind mount exposes the **host's macOS-arm64 `node_modules`** to the Linux container. Agents were forced to hand-patch linux native modules because the host's wrong-platform binaries were already present.

---

## Decision

Mount an **anonymous Docker volume** at `<project>/node_modules` on darwin rw project mounts — a standard shadow-volume pattern (`src/v2/spawn.ts`, the `#245` block).

```
-v <projectContainerPath>/node_modules   # anonymous volume, no host path
-e FORGE_NM_SHADOW=<projectContainerPath>/node_modules
```

The container's `node_modules` becomes a container-local ext4 filesystem. Writes to it never go back through grpcfuse, and the host's arm64 modules are hidden so the agent installs correct linux ones. Originally `--rm` (then present on all agent containers) auto-removed the anonymous volume on exit — no cleanup debt. **Update (FG-492, 2026-07-09):** task containers no longer run `--rm` (they're retained on failure for causal-evidence forensics); every reap path (`finalizeContainerRetention`, reconcile's `defaultContainerReap`, retry's pre-spawn reap) passes `docker rm -f -v` so the anonymous shadow volume is still removed with the container.

**Three supporting fixes landed in the same commit (02ca0b9):**

1. **`spawn.ts`** sets `FORGE_NM_SHADOW=<path>` so the entrypoint knows which path to chown.
2. **`agent-entrypoint.sh`** chowns the root-owned anonymous volume to `agent:agent` (UID 1000) via `sudo` before exec'ing the agent command, so `npm install` can write into it.
3. **`agent-dev-worker.Dockerfile`** now installs the `sudo` binary. DEC-009's `NOPASSWD:ALL` sudoers line had always assumed sudo was installed; it was never actually installed, so every `sudo` call in the entrypoint silently no-op'd.

**Scope**: darwin + rw only. Linux hosts have no grpcfuse and provide matching-arch modules. Red agents use ro mounts and never write, so they are unaffected. Escape hatch: `FORGE_NO_NM_SHADOW=1` disables the shadow without a code change.

---

## Consequences

**Positive**:
- The grpcfuse corruption path is eliminated by construction — native-module writes land on ext4, never on grpcfuse, so the xattr is never stamped.
- The arch-mismatch problem is eliminated — the host's arm64 modules are hidden; the agent always installs linux ones.
- No host leak: validated on a clean Mac (shadow is ext4, host's modules invisible inside the container, agent writes succeed, zero modules visible from the host side post-exit).

**Negative / Trade-offs**:
- **Behavioral shift for agents**: the container's `node_modules` starts EMPTY. Build and test agents that previously relied on the mounted host modules must now run a clean install (`npm install` / `pnpm install` / `yarn`) at the start of their task. This is the correct behavior — agents should own their dependency state — but any seed or workflow that assumed pre-populated modules will break until updated.

**Risks**:
- The SIGKILL-under-EDR path only reproduces with CyberArk EPM active. The grpcfuse write-back root cause is eliminated by construction, but final end-to-end confirmation (no SIGKILL on a corp Mac) is pending before ticket #245 is closed.
