---
id: FG-462
type: story
status: done
title: review-loop must not pass backlog close/move findings to engineer fixers
created: 2026-07-05
closed: 2026-07-05
closed_commit: ca2b306
---

## Problem

During the FG-459 review-loop (`run-review-loop-fg-459-c8a38a`), the red reviewer produced a `needs_fix` finding that `backlog/stories/FG-459-...md` still lived under `backlog/stories/` with `status: active` even though commit `cc3a09f` implemented the fix.

`forge review-loop` then passed that finding verbatim to the engineer fixer (`task-engineer-1a51e0`) as work to address. The engineer reported moving FG-459 to `backlog/done/` and flipping the ticket to `status: done`.

That is the wrong role boundary:

- Reviewers may say an implementation appears closeable after review and verification.
- Engineer fixers may fix code/tests/docs within the implementation scope.
- Backlog close/move is an orchestrator closeout action after review-loop pass, deterministic verification, merge, and the close audit.

The close move did not land in this incident; the committed fixer round only changed `src/v2/reconcile.test.ts`. But the prompt and result still prove the review-loop can ask an engineer to close its own implementation ticket.

## Goal

Prevent review-loop from routing backlog close/move work to engineer fixers. The loop should distinguish:

- stale closeout text on an already-closed ticket, which can be a real docs/backlog drift finding, from
- an active ticket whose implementation is under review and not yet merged/closed, which is normal and should not be fixed by the engineer.

## Acceptance Criteria

- A reviewer finding that proposes `forge backlog close`, moving the current implementation ticket to `backlog/done/`, or changing that ticket's status to `done` is not passed to the engineer fixer as a fix item.
- `review-loop` may surface such a finding to the orchestrator as closeout guidance, e.g. "close ticket after merge/verification", but it must not ask the fixer to perform the close/move.
- The reviewer prompt/rubric is clarified so "stale closeout text" applies to already-closed tickets or committed closeout artifacts, not to the active ticket currently being reviewed before merge.
- If a fixer nevertheless modifies `backlog/stories/<current-ticket>.md` only to close/move the ticket, review-loop treats it as out-of-scope and does not commit it.
- Tests cover the FG-459 shape: reviewer returns a finding anchored on the current ticket's active backlog file recommending move-to-done; the generated fixer prompt omits that item or classifies it as orchestrator-closeout guidance, while still passing legitimate code/test findings through.

## Non-Goals

- Does not remove review-loop's ability to catch genuinely stale backlog/docs text.
- Does not change the orchestrator's final closeout authority.
- Does not prevent backlog-only tickets from being worked by the orchestrator in an in-session/ticketing lane.

## References

- `run-review-loop-fg-459-c8a38a`
- `task-red-wide-a09ddc` — reviewer finding about FG-459 still active in `backlog/stories/`
- `task-engineer-1a51e0` — fixer reported moving FG-459 to `backlog/done/`
- `src/cli/commands/review-loop.ts` — fixer prompt construction and out-of-scope commit handling
