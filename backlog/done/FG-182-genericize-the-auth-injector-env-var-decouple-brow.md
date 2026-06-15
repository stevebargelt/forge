---
id: FG-182
type: story
status: done
title: Genericize the auth injector env var (decouple browser-tools from forge)
---

**Closed:** 2026-05-29.

**Found during #176 Slice 2.** The browser-tools auth injector keys off `FORGE_AUTH_STATE`. The senior engineer noted (agreed) that loading a preloaded storage-state file is a GENERIC browser-tools capability, not forge-specific — "if a storage-state env var is set, load it." Renaming `FORGE_AUTH_STATE` to a neutral name (e.g. `BROWSER_TOOLS_STORAGE_STATE`) in both `auth-inject.js` and forge `spawn.ts` decouples the feature, makes it cleanly upstreamable to `badlogic/pi-skills`, and keeps the upstream change non-forge-branded.

**Scope:** rename in `auth-inject.js` (read the neutral var), forge `spawn.ts` (set the neutral var instead of FORGE_AUTH_STATE), update the #176 ADR. Pairs with the fork/pin ticket — do the rename before pushing to the fork so upstream history is clean. Small, isolated change.