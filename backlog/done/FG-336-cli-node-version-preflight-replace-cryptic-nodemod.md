---
id: FG-336
type: story
status: done
title: "CLI: Node-version preflight — replace cryptic NODE_MODULE_VERSION crash with clear 'requires Node >=24'"
created: 2026-06-19
closed: 2026-06-19
---

**Found:** 2026-06-19, twice in one session. Running any forge command on Node 20 crashes with:
`The module .../better-sqlite3/.../better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 115.`
better-sqlite3 v12's binding is built for Node 24 (ABI 137); a non-login/VS Code shell that lands on Node 20 (ABI 115) hits this. The message is opaque — nothing says "forge needs Node 24."

**Proposed:** a Node-version preflight in the CLI entrypoint, BEFORE the first better-sqlite3 require, that checks `process.versions.node` against the required major (>=24) and fails loud with: "forge requires Node >=24 (you're on Node X) — run `nvm use 24`." Small, isolated change in the CLI entry.

**Note:** related but separate from "do scripts need `nvm use 24`" — repo scripts don't (all node execution is in-container); this is about the host CLI's own runtime resolution for arbitrary callers, which no script can fix.

Relates: #333 (Node 24 + better-sqlite3 v12 unification), #306.
