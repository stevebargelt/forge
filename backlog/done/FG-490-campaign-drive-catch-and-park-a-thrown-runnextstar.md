---
id: FG-490
type: story
status: done
title: "campaign drive catch-and-park: a thrown runNext/startRun transitions running->paused with a recoverable item instead of stranding the campaign (review F7)"
created: 2026-07-07
closed: 2026-07-08
closed_commit: b1d9c09
---

Source: independent engineering review 2026-07-06 (notes/forge-engineering-review-2026-07-06.md), finding F7 / backlog rec #9. Observed live 2026-07-07 ~16:03Z: an externally-killed drive process left campaign-4e43b64871d3 stranded in `running` (recovered manually via `forge campaign pause`).

## Problem

The campaign drive path awaited `runNextFn` / `startRun` uncaught (`src/campaign/executor.ts`) after the campaign had already transitioned to `running`. Any dispatch-time throw propagated out with the campaign left in `running`: `resume` refused (`not_paused`), `start` refused, and the only ways back were `forge campaign pause` (if the operator knew to try it) or manual state surgery.

## Resolution note (2026-07-07, at closeout — AC1 wording amended with review evidence)

As filed, AC1 required a "recoverable NON-TERMINAL state" for both throw shapes. The review-loop's round-2 findings PROVED that shape wrong for startRun-throws: parking awaiting_gate while the synthetic run row was terminal meant the first `resume` re-terminalized the item to `campaign_system`, which `forge campaign retry` refuses — recoverable-looking, actually stranded. The shipped design distinguishes the shapes by what the throw means:

- **runNext-throw** (run exists, active): item parks `awaiting_gate` (non-terminal) — FG-485's liveness-first reattach re-drives it on the next `resume`.
- **startRun-throw** (nothing ever dispatched): item parks `failed`/`blocked`/`blockerKind: infrastructure` (terminal but RETRYABLE) with a consistent terminal run row — recovery is FG-489's `forge campaign retry`, named in the rethrown guidance.

The invariant that matters — every drive-path throw leaves the campaign paused with the item recoverable through supported verbs — holds for both shapes and is proven by an end-to-end test (throw → paused + drive_error event → retry resets → resume re-dispatches).

## Acceptance criteria (as shipped — amendments per the resolution note)

- [x] With an injected throwing `runNextFn` (and separately `startRun`), the campaign lands `paused`, the in-flight item is in a state recoverable through supported verbs (awaiting_gate re-drive for runNext; failed/infrastructure + retry for startRun), and the thrown error still surfaces to the caller/CLI with next-action guidance naming the recovery path. Under `--json`, start/resume render a structured `stopReason: "drive_error"` object (added during review — the orchestrator is the primary consumer).
- [x] The failure is durably recorded — new `campaign_item.drive_error` event, written BEFORE any state change so the raw error survives cron/service invocations.
- [x] `forge campaign resume` succeeds after the parked state (runNext shape: re-drives; startRun shape: after `forge campaign retry`, resume re-dispatches — proven end-to-end).
- [x] If the park-transition itself fails, the original error still propagates — the wrapper never masks the root cause (secondary failure swallowed, tested).

## Ship record

PR #63 (merge 1f8ced8; commits 58238f3 catch-and-park, 26b8693 structured drive_error JSON, f7b6161 loop round-1 blockerKind cleanup, b6349f4 startRun retry-composition). Three review rounds; verification green at every round.

## Reopen record (2026-07-08)

Reopened same-session on an operator-reported HIGH: the drive_error `--json` `guidance` field was unconditionally `forge campaign resume <id>`, but the startRun-throw shape parks failed/blocked/infrastructure and resume SKIPS failed items — an orchestrator following the guidance would let the campaign reach complete_with_issues instead of recovering the item (docs encoded the same mismatch, so tests had "consciously accepted" it). Fix: guidance now branches on the parked shape (retry-then-resume for the infrastructure park; bare resume for awaiting_gate and the unreachable no-parked-item fallback), with CLI-boundary tests for both reachable shapes across start and resume, plus a verify-only test-engineer trace proving the fallback branch has no in-process producer. PR #64, merge b1d9c09. The earlier "proven end-to-end" claim in this ticket applied to the executor recovery cycle — the CLI guidance surface above it was the part review rounds and tests had not pinned.