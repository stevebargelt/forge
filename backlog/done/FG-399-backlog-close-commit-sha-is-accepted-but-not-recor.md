---
id: FG-399
type: story
status: done
title: "backlog close: --commit <sha> is accepted but not recorded for structured tickets (no commit/closed-sha frontmatter field) — restore the close audit trail lost vs the legacy path"
created: 2026-06-24
closed: 2026-06-24
closed_commit: 639ace3
---

## Problem

`forge backlog close <id> --commit <sha>` accepts a commit hash, but the structured backlog close path does not persist it. The CLI option remains visible, yet `src/cli/commands/backlog.ts` ignores `opts.commit`, and the structured ticket frontmatter model only parses/serializes `closed`, not a close commit field.

That silently drops the audit trail that operators expect when closing a ticket against a shipped commit.

## Goal

Restore a structured close audit trail for `--commit <sha>` without reintroducing legacy `BACKLOG.md` behavior.

## Acceptance Criteria

- Structured ticket frontmatter supports a close commit field.
- `forge backlog close <id> --commit <sha>` records the provided commit on the done ticket.
- Closing without `--commit` preserves today's behavior: status becomes `done`, `closed` is recorded, and no empty commit field is emitted.
- `readTicket` preserves the close commit field for done tickets.
- `writeTicket` round-trips the close commit field.
- Existing done tickets without a close commit continue to parse.
- Tests cover close with commit, close without commit, and read/write roundtrip.

## Non-Goals

- Do not reintroduce legacy `BACKLOG.md` writes or parsing.
- Do not validate that the commit exists in git in this story.
- Do not change close atomicity; FG-397 owns the non-atomic move/write problem.
