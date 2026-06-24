---
id: FG-403
type: story
status: active
title: "backlog listTickets: status=done scans only done/, so a partial close (done-content written to active dir before rename) is invisible to list --status done and skips ghost-dup detection — scan all dirs then filter by frontmatter (FG-397 follow-up)"
created: 2026-06-24
---

## Problem

Post-merge review of FG-397 found its partial-failure acceptance is not fully met for listTickets.

src/backlog/structured.ts listTickets() narrows filters.status === 'done' to scan ONLY done/. But atomicMoveFile() writes the updated (status: done) content to the SOURCE path (in stories/epics/ideas) and THEN renameSync()s it into done/. If the process dies after that write and before the rename, the only visible copy is a status: done ticket still sitting in an active dir.

Consequences:
- list --status done scans only done/, so it returns NOTHING for that stranded closed ticket — even though readTicket/show (which scan all dirs) find it. Reproduced manually.
- Ghost active+done duplicate detection does not fire on the list --status done path, because the active dirs are never scanned.

## Goal
Make listTickets integrity-correct regardless of status filter: a partially-moved or ghost-duplicated ticket must be found and (for duplicates) warned about on every path.

## Acceptance Criteria
- listTickets scans ALL structured dirs for integrity + dedup FIRST, then applies type/status/search filters from frontmatter (not from which dir was scanned).
- list --status done surfaces a status: done ticket regardless of which directory it physically sits in after a partial move.
- Ghost active+done duplicate detection fires (loud warning, done/ copy wins) on the --status done path too.
- Regression tests: (a) --status done ghost-duplicate emits the warning and returns the done copy; (b) the source-rewritten-before-rename partial state (done-content file stranded in an active dir) is returned by list --status done.

## Non-Goals
- Do not change atomicMoveFile's rename strategy here (FG-397 owns the move; this is the read/list side). If the cleaner fix is to write the temp into done/ first, note it but keep this ticket scoped to listTickets integrity.
- No legacy BACKLOG.md.