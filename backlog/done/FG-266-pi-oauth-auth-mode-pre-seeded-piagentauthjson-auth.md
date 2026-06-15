---
id: FG-266
type: story
status: done
title: "pi: OAuth auth mode (pre-seeded ~/.pi/agent/auth.json) + auth seam"
---

**Closed:** 2026-06-06.

**Phase:** Walk. Part of #258.
Support pi OAuth providers (Claude Pro / ChatGPT / Copilot) via a pre-seeded `~/.pi/agent/auth.json` mounted into the container (mirror the forge-claude-oauth volume); integrate with the provider-availability/auth seam (#226).
**Acceptance:** a pi run authenticates via mounted auth.json without interactive login; expiry/refresh behavior documented.
**Depends on:** runtime story.