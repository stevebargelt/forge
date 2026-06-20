---
id: FG-272
type: story
status: done
title: "Implementer seeds: tell agents node_modules is a fresh container-local volume — install before build (#245 companion)"
closed: 2026-06-20
---

**Companion to #245** (container-local node_modules shadow volume, commit 02ca0b9). With the shadow volume, the container's `/project/node_modules` starts EMPTY (the host's modules are intentionally hidden, and on darwin they're wrong-platform anyway). Build/test agents must run a clean install (npm/pnpm/yarn, per the project) before building/testing, instead of leaning on the mounted host modules.

Today agents muddle through (the forge-site run showed them hand-fetching `@esbuild/linux-x64`/rollup) — a clean `npm install` into the fresh volume is strictly better, but the implementer seeds should say so explicitly so it's reliable, not improvised.

**Scope:** add a short note to the implementer seeds (engineer, frontend-specialist, backend-specialist, agentic-platform-builder) — "the container's node_modules is a fresh volume, not the host's; run the project's install before building/testing." `forge-test` already rebuilds its own deps in scratch, so tests are covered; this is about dev-server/build steps. Markdown-only → documentation-maintainer.

Low priority until #245 is validated on the corp Mac (the shadow volume is darwin-only and agents already install in practice), but worth doing so the behavior is documented rather than emergent.