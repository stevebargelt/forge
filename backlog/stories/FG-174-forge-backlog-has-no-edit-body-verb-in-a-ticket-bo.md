---
id: FG-174
type: story
status: active
title: "forge backlog has no edit-body verb; ## in a ticket body silently breaks the parser roundtrip"
---

Two related rough edges, both hit 2026-05-29 while filing #173.

**Part 1: DONE - No edit-body verb.** forge backlog edit <id> --body <text|-> now exists (landed in commit a3a0556).

**Part 2: TODO - ## in ticket body breaks parser.** The parser treats any ^## line as a section boundary. Need to either reject/escape ## in bodies, or make the parser only recognize ## when the name is in SECTION_ORDER.