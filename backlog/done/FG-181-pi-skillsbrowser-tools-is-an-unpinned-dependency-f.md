---
id: FG-181
type: story
status: done
title: pi-skills/browser-tools is an unpinned dependency — fork + pin the auth injector
---

**Closed:** 2026-05-29.

**Found during #176 Slice 2.** forge mounts `${FORGE_BROWSER_TOOLS_DIR:-~/pi-skills/browser-tools}` into agent containers (read-only) — currently `~/.claude/skills/browser-tools` is a symlink to `~/pi-skills/browser-tools`, a checkout of the THIRD-PARTY repo `badlogic/pi-skills` sitting on upstream `main` (SHA 75d32a3 at time of writing). The #176 auth injector (`auth-inject.js` + a `browser-nav.js` edit) lives there as UNCOMMITTED local edits on top of upstream. forge therefore mounts "whatever SHA that checkout happens to be at" with zero pinning — works on this machine, no reproducible dependency state. A fresh clone / another machine / a container rebuild silently lacks the injector, which is exactly the silent-skip failure #176 exists to kill.

**Senior-engineer recommendation (relayed, agreed):**
- Fork or branch `badlogic/pi-skills`; commit the auth changes there.
- Pin forge to a specific git SHA / tag of the fork.
- Add a forge compat note: "auth profiles require pi-skills browser-tools >= commit Y."
- Patch files are an acceptable temporary escape hatch only, not the main strategy. Fork + pinned SHA is more boring and reproducible.

**Open sub-decisions (deferred from the build session):**
- Pin mechanism: (a) fork + documented required-SHA + a forge PREFLIGHT that hard-fails at dispatch when the mounted browser-tools lacks the injector — extends the spawn.ts browser-tools-mounted guard already added in #176 Slice 3 to also assert `auth-inject.js` presence; (b) git submodule in forge pinned to a SHA; (c) bake the fork into the agent image at a pinned SHA (revisits #128 mount-don't-bake). Leaning (a): boring, reproducible, no submodule friction, fits no-build-step workflow.
- Fork target is an outward action on the user's GitHub (gh repo fork) — needs the user.

**Until done:** #176 auth profiles only work on this machine. Blocks shipping auth-profile to any other environment.