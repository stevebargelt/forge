---
id: FG-494
type: story
status: done
title: "notify/ntfy: em-dash (any non-Latin-1 char) in a milestone title breaks the push with a ByteString header error — event records but no notification is delivered"
created: 2026-07-07
closed: 2026-07-09
closed_commit: 75cf4db
---

Observed 2026-07-07: forge notify milestone --title 'Campaign-autonomy batch done: FG-485/488/489/490 all shipped (PRs #60-#63)' --body '... all_shipped. FG-485 disproved-as-filed (fix: liveness-first + messaging + tests). ...' failed the ntfy delivery with: 'network: Cannot convert argument to a ByteString because the character at index 22 has a value of 8212' (U+2014 em-dash, likely placed in an HTTP header such as X-Title). The orchestrator.milestone event was still recorded, so the audit trail exists but the operator receives NOTHING — a silent notification drop for any title/body routed into a header with non-Latin-1 content. Orchestrator prose uses em-dashes constantly, so this is a common-path failure, and it directly undercuts the F9 goal (unattended failures must ping).

## Acceptance criteria
- [ ] Titles/bodies containing arbitrary Unicode (em-dash, arrows, emoji) deliver successfully via ntfy — encode header-bound fields (RFC 2047, percent-encoding, or ntfy's documented header encoding) or move them to the request body.
- [ ] A delivery failure is loudly visible in the CLI output AND recorded distinctly from a successful push (today the event row looks identical either way).
- [ ] Regression test with a non-Latin-1 title through the real formatting/delivery boundary (network stubbed).