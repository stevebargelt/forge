---
id: FG-230
type: story
status: done
title: forge init/upgrade silently skips on unbalanced orchestrator markers (dangling end, missing start)
---

**Closed:** 2026-06-01. Commit `2819fe6`.

Hit live on the Pixtron project: its CLAUDE.md had `<!-- forge:orchestrator-end -->` but the matching start marker was gone (stray edit). `forge upgrade` checks only `includes("<!-- forge:orchestrator-start -->")` (upgrade.ts:67) and `forge init` keys the in-place replace on BOTH markers (init.ts:216-219, startIdx>=0 && endIdx>startIdx). With start absent:
- upgrade reports "no orchestrator block found; skipping" and skips step 4 — silently, forever, even though a (half-fenced) block is clearly present.
- init would APPEND a second fenced block rather than repair, producing a duplicate + a dangling end marker.

The user saw a block in CLAUDE.md and couldn't reconcile it with the "no block found" message.

Proposal:
- Detect an unbalanced marker pair (exactly one of start/end present, or end-before-start) and surface it: warn with the line number and the literal fix ("missing <!-- forge:orchestrator-start --> before your orchestrator section"), rather than silently treating it as "no block".
- Optionally offer `forge init --repair` (or auto-insert the missing marker) when exactly one marker is found and the heading `# forge orchestrator` is present.
- A lone/duplicate marker should never cause init to append a second block.

Low-risk, operability. Tie-in: how-to-upgrade.md (document the marker contract).