---
id: FG-127
type: story
status: done
title: "System Map: red→parent arrows render as dotted tether"
---

**Closed:** 2026-05-13. Shipped via forge feature run on `red-arrow-127` branch (the first forge run that exercised #128 end-to-end). Commit `ec6a519`.

**What landed:** `src/dashboard/html.ts` red-edge style — `line-style: 'dotted'`, `target-arrow-shape: 'none'`, `opacity: 0.4` (was 0.7). Width unchanged at 1.

**Option from the original entry:** option 6 (dotted thin line, no arrowhead, low-opacity magenta tether). Reads as "associated, not flow into" — matches reds-as-side-channel-audit, drops the misleading downstream-consumer connotation.

**Notes on the forge run that produced this:** the architect caught two real gotchas the brief didn't flag — the base edge selector's `target-arrow-shape: 'triangle'` is inherited unless explicitly overridden, and Cytoscape distinguishes `dotted` from `dashed`. Implementer made exactly those three style changes plus the override. First verify-phase run skipped browser-tools (reasoned "small CSS = code, not UI"); second run after the seed tightened invoked browser-tools 22 times and produced a real screenshot — validates both the change and #128 end-to-end. See the #128 Done entry for the seed-copy iteration.

**Co-shipped:** #121 (env-snapshot bedrock auth) commit `8e7306c`. The original run was blocked by stale STS cache under mount-mode auth — fixed by implementing Jeff & Terry's env-snapshot pattern. Originally filed as deferred-to-v2 in the BACKLOG; landed here because it was the actual blocker on this run.