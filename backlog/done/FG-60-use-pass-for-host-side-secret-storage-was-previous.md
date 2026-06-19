---
id: FG-60
type: story
status: done
title: "Use `pass` for host-side secret storage (was previously #47, kept here as it now applies to PROMPT.md design output)"
closed: 2026-06-19
---

**Why:** Same as the original #47 — secrets like `PENCIL_CLI_KEY` shouldn't sit in a `.env` file forever. With FORGE-DEC-014 the consumer of `PENCIL_CLI_KEY` moves *out* of forge entirely (it's used by the human's host-side Claude Code, not by a forge container). But forge still touches host-side env in `forge auth` and possibly in future host-side tools. Keeping the entry but renumbered to reflect the architectural pivot.
**How to apply:** When forge needs another host-side secret (e.g., for a future GitHub or Slack integration), build the `pass` wrapper then. Until then, this is dormant.
**Status of original #47:** content unchanged but no longer about PENCIL_CLI_KEY-in-container — it's about whatever host-side secrets forge accumulates next.