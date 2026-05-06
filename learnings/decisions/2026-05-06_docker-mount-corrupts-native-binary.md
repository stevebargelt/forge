# Decision: Docker mount of project dir can corrupt native node binaries (and the recovery)

**ID**: FORGE-DEC-011
**Date**: 2026-05-06
**Status**: Documented (gotcha, no code fix yet)
**Decided by**: Steven (forge build, hit during dashboard run-dashboard-4f86a9 build phase)
**Supersedes**: N/A
**Scope**: forge

---

## Context

During the dashboard build phase, the agent container ran with `-v /Users/steven.bargelt/code/forge:/project:rw` (the entire forge source tree mounted writable into the container). The container is `agent-dev-worker` running on Docker Desktop for Mac, which uses **grpcfuse** as the host→container filesystem layer.

After the implementer wrote files into `/project/src/...` and presumably ran `npm test` inside the container (which reaches into `node_modules/`), `forge` commands on the **host** started silently dying with exit 137 (SIGKILL) — no error output, no stderr. Only the `new Database(...)` call in better-sqlite3 was killed; plain `node` and `node -e 'fs.readFileSync()'` worked fine.

Investigation showed the native binary `node_modules/better-sqlite3/build/Release/better_sqlite3.node` had picked up a `com.docker.grpcfuse.ownership` extended attribute. The macOS loader (or CyberArk EPM running on this host) treated the modified binary as suspicious and silently killed processes that loaded it.

Reinstalling `better-sqlite3` (`rm -rf node_modules/better-sqlite3 && npm install better-sqlite3`) replaced the binary with a fresh copy lacking the xattr; everything immediately worked again.

---

## Problem

**What happens when an agent container mounts the project rw and writes through to native binaries the host depends on?**

---

## Findings

1. **Docker grpcfuse leaves extended attributes** on files written through the mount. These are normally harmless metadata. But on native binaries (`.node` modules, `.dylib`, etc.), they can interact poorly with macOS code signing checks and EDR/EPM tools.

2. **CyberArk EPM** (or any similar runtime application protection) can silently kill Node processes that load tampered/modified native binaries. No log on the host side; the process just exits 137. From the user's point of view: forge stops working.

3. **Plain SQLite CLI was unaffected** — only the Node native binding was killed. So the data was always safe; only the Node process couldn't load.

4. **The agent doesn't intentionally touch node_modules**. But running `npm install`, `npm test`, or `npx tsx` inside the container against a mounted project DOES touch node_modules (caching, lockfile updates, native rebuilds). Any of those can cascade into the host's native binaries via the mount.

---

## Decision

**Mount the project rw for blue agents, but document this gotcha clearly and provide a one-line recovery.**

For now: `rm -rf node_modules/better-sqlite3 && npm install better-sqlite3` is the recovery. Add to the operations doc.

Three follow-up paths to consider, in order of cost:

1. **Document only** (this ADR): cheapest, sufficient for solo personal use where you can re-run `npm install`.
2. **Mount node_modules read-only via a separate `-v node_modules:/project/node_modules:ro` overlay**: prevents the agent from writing through to host node_modules. Caveat: agents that genuinely need to install packages would need their own `node_modules` at a different path.
3. **Mount only specific subdirs**: instead of `-v $PROJECT:/project:rw`, mount `-v $PROJECT/src:/project/src:rw`, etc. Fine-grained but invasive — the agent expects a normal project layout.

Also worth: **detect the corruption proactively**. Run a small "can we open SQLite?" check at the start of every `forge` command and, if it fails, print the recovery command instead of dying silently.

---

## Consequences

**Positive**:
- Documented; won't be a mystery the next time it happens.
- Recovery is one command.

**Negative / Trade-offs**:
- Anyone running forge behind CyberArk-class EDR will hit this until we either (a) overlay-mount node_modules read-only or (b) detect-and-warn proactively.

---

## Implementation Notes

Recovery command:
```bash
cd ~/code/forge && rm -rf node_modules/better-sqlite3 && npm install better-sqlite3
```

Diagnostic — confirm it's this issue, not something else:
```bash
# Run any forge command. If it dies with exit 137 silently:
xattr -l node_modules/better-sqlite3/build/Release/better_sqlite3.node
# Look for `com.docker.grpcfuse.ownership` — that's the smoking gun.
```

Better long-term fix (not yet implemented):
- Add a `-v $FORGE_REPO_NODE_MODULES:/project/node_modules:ro` to the agent docker run when the project IS the forge repo itself (detected by path or env var). Means the agent can't `npm install`, but it also can't corrupt host node_modules.

---

## Revisit Conditions

- If a future forge release introduces a different native binding that gets corrupted by the same path
- If macOS / Docker Desktop / CyberArk update behavior such that grpcfuse no longer leaves the xattr
- If we add a "forge doctor" command that proactively checks for this and other known gotchas
