---
id: FG-334
type: story
status: active
title: "FG-258 sub: agent image -> Node 24, pi -> 0.78+"
created: 2026-06-19
---

**Why:** The `agent-dev-worker` Docker image is pinned to Node 20 (`setup_20.x`). That forces pi (`@earendil-works/pi-coding-agent`) onto the legacy 0.74.2 line — the Dockerfile comment states the 0.78+ line requires Node >=22 and can only be adopted "after the image moves to Node 22." pi is the FG-258 provider pilot, so this directly blocks moving FG-258 onto current pi.

**What:**
- Agent Dockerfile: `setup_20.x` -> `setup_24.x`; rebuild the image.
- Bump `PI_CLI_VERSION` from the `legacy-node20` 0.74.2 pin to a 0.78+ release.
- Re-verify the #245 node_modules shadow-volume chown logic still holds under the new base.

**Acceptance:** image builds; `node --version` and `pi --version` correct inside the container; a LIVE agent run (forge invoke) completes and produces a usage row on pi 0.78+. The live run is the real gate — version strings alone are not acceptance.

**Risk:** high blast radius — every `forge invoke`/`forge new` uses this image. Build to a side tag and verify before replacing the live `agent-dev-worker`. Belongs to the FG-258 epic; depends conceptually on FG-333 landing the host/repo on Node 24 first.
