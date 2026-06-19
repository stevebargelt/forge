---
id: FG-333
type: story
status: done
title: Unify repo on Node 24 LTS + better-sqlite3 v12 via npm workspaces
created: 2026-06-19
closed: 2026-06-19
---

**Why:** The repo is a monorepo without monorepo tooling — root (`package.json`) and `dashboard/package.json` each declare their own `better-sqlite3` (root v11, dashboard v12) with separate `node_modules` and separate native bindings. The two majors target different Node ABIs, which is why the dashboard only tested cleanly under Node 22 while the CLI ran on Node 20. Best practice for this shape is one-version policy + a single hoisted dependency + one pinned runtime.

**What:**
- Convert the repo to npm workspaces (root + `dashboard`) so `better-sqlite3` is hoisted to a single install/binary.
- Align both packages on `better-sqlite3@^12.11.1` (v12 supports Node 20–26, so the fix is version-up, not pin-down).
- Add `.nvmrc` = 24 and bump root `engines` to `>=22`.
- Rebuild the native binding; full suite green on both Node 20 (fallback) and Node 24 (target).

**Acceptance:** one `better-sqlite3` major across the repo, one Node version, no "dashboard tests need a different Node" special-case. Replaces the loose-end "pin dashboard better-sqlite3" item from the session notes.

**Note:** Self-contained and independent of the agent-image/pi bump (that is the FG-258 sub-item). Do not couple them — this one ships value alone.
