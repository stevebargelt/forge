---
id: FG-409
type: story
status: done
title: moveTicket leaves stale closed/closed_commit frontmatter when reopening done→active
created: 2026-06-25
closed: 2026-06-26
closed_commit: 1a47f92
---

## Problem

Reopening a closed ticket via `forge backlog move <id> story` sets status:active and relocates done/→stories/, but spreads the existing frontmatter unchanged — so the reopened active ticket still carries `closed:` and `closed_commit:` from when it was closed. An active ticket showing a close date + close sha is misleading state. Surfaced reopening FG-391 (had to hand-strip the two fields after the move).

## Acceptance Criteria

- When moveTicket moves a ticket OUT of done/ (i.e. transitioning to an active state), it clears the `closed` and `closed_commit` frontmatter fields.
- Moving between active type dirs (idea/story/epic) is unaffected.
- Test: reopen a closed ticket via move; assert status active AND no closed/closed_commit fields remain.

## Notes
src/backlog/structured.ts moveTicket (~line 345). The `updated` frontmatter currently only overrides type+status.