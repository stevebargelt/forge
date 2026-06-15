---
id: FG-174
type: story
status: active
title: "forge backlog has no edit-body verb; ## in a ticket body silently breaks the parser roundtrip"
---

Two related rough edges, both hit 2026-05-29 while filing #173.

**No edit-body verb.** `forge backlog` exposes file/close/move/notes — there is no way to edit an existing ticket's body. A typo or malformed body can only be fixed by close+refile (burns the sticky number AND leaves the broken body relocated, not removed) or by hand-editing BACKLOG.md (which CLAUDE.md forbids). #173's body had to be fixed via a direct Edit because no CLI path existed. Add `forge backlog edit <id> --body <text|-\>` (replace body, keep heading + sticky).

**`##` in a ticket body silently breaks the byte-for-byte roundtrip.** The parser's SECTION_HEADING_RE = /^## (.+)$/ (src/backlog/parse.ts:24) treats any `## X` line as a top-level section boundary, even inside a ticket body. A ticket whose body uses `##` subheadings gets truncated at the first one and the remainder lands in unrecognized-section limbo, so parse(BACKLOG.md)→serialize() no longer roundtrips and parse.test.ts goes red. Convention is bold lead-ins (`**X:**`); `###`-without-`#NNN` is also body-safe (TICKET_HEADING_RE requires the `#<id> — ` shape). Harden: either have `forge backlog file` reject/escape `^## ` lines in a body, or make the parser only treat `## ` as a section when the name is in SECTION_ORDER. Related to #141 (parser as single-source-of-truth).