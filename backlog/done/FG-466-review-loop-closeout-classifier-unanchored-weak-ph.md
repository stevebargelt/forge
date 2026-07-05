---
id: FG-466
type: story
status: done
title: "review-loop closeout classifier: unanchored weak-phrase + ticket-context-window heuristic can withhold a legit application-domain bug from the fixer"
created: 2026-07-05
closed: 2026-07-05
---

## Problem
`isCloseoutFinding`'s UNANCHORED branch uses `isCloseoutActionPhrase`: STRONG close/move phrases (forge backlog close, backlog/done, close the ticket) OR a WEAK phrase (move/status/mark ... done, should be closed) with a `ticket`/`backlog` mention within CLOSEOUT_CONTEXT_WINDOW (40) chars. An unanchored application-domain finding about issue-tracker/support-"ticket" code that uses close/done vocabulary near the word "ticket" can be misclassified as closeout and silently withheld from the fixer.

## Severity
Fail-safe / low. It withholds a FIXABLE finding (it doesn't get auto-fixed; it's surfaced to the orchestrator in the note). No wrong-ship, data loss, or trust bypass. Only affects UNANCHORED findings (most real findings are anchored → unaffected). Surfaced by FG-462 review-loop run-2 (run-review-loop-fg-462-7ca9d6), round-2 finding.

## Direction
Options: (a) tighten the unanchored branch to STRONG phrases only (drop the weak+window heuristic) — simpler, at the cost of missing verb-light unanchored closeout recs; (b) require the ticket's own id in the unanchored summary; (c) accept as-is. Pick after weighing false-withhold rate vs missed-closeout rate.

## Reference
src/v2/review-loop.ts isCloseoutActionPhrase / CLOSEOUT_WEAK_RE / CLOSEOUT_CONTEXT_WINDOW. FG-462.