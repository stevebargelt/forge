---
id: FG-521
type: story
status: active
title: "operator surfaces: show --json drops verdicts, red next-command is unrunnable, campaign show contradicts report on done-audit gaps"
created: 2026-07-11
---

## Problem

Four operator-surface read-side defects (review findings F20 + F10 + one dashboard one-liner). All pure read-side; zero write-path risk.

**(a) `forge show <task> --json` drops the verdicts array.** `performShow` already fetches verdicts for a task (src/cli/commands/show.ts:29: `verdicts: verdictsForTask(task.id)`), and the human-readable path prints them, but the task JSON branch (show.ts:~800-843) serializes only `{ task, events, diagnostic }` — the verdicts never appear in JSON output. An orchestrator consuming `--json` cannot see red verdicts at all.

**(b) The human verdicts section makes the suggested next-command unrunnable.** The suggested next-command for `red_blocked` / `blocked_by_red` is literally `forge show <redTaskId>` (show.ts:~460, ~505), but the verdicts section (show.ts:~936-945) prints only `redRole (authority): verdict (confidence)` + findings — the redTaskId is never printed anywhere, so the operator has nothing to paste into the suggested command.

**(c) `campaign show` contradicts `campaign report` on done-audit gaps.** `computeNextShowAction` (src/campaign/report.ts:~364-422) returns `"complete — none"` unconditionally for a complete campaign (line ~375), while `computeNextOperatorAction` (report.ts:~472-501) consults the doneAuditMap and surfaces "shipped items have unresolved done-audit gaps — ...". A completed campaign with unresolved done-audit gaps renders "complete — none" in show and a gap warning in report. Fix: make show's next-action a projection of report's machine (pass the doneAuditMap / verdict into computeNextShowAction), not a parallel one.

**(d) Phantom task status in the dashboard.** `dashboard/src/queries.ts:166` filters on `'awaiting_human_input'`, and `dashboard/src/shell.ts:196` carries a CSS badge for it — but that status exists in no TaskStatus type and matches nothing. Delete both.

## Acceptance Criteria

- (a) `forge show <taskId> --json` for a task with red verdicts includes the verdicts array (same data the human path prints).
- (b) The human verdicts section prints each verdict's redTaskId such that the suggested `forge show <redTaskId>` next-command is copy-pasteable; assertion on the HUMAN-readable output (house rule: verify the operator surface, not just the JSON).
- (c) A completed-campaign-with-done-audit-gaps fixture where `campaign show`'s next-action and `campaign report`'s next-operator-action AGREE (show no longer says "complete — none" when report flags gaps); show's next-action derives from the same done-audit inputs as report's.
- (d) `awaiting_human_input` appears nowhere in dashboard/src (query + CSS removed); dashboard queries behave identically otherwise.
- Tests assert on human-readable output for (b) and (c), not only JSON fields.

## Notes

Filed 2026-07-10 as Item 2 of the operator-directed reliability queue (review findings F20 + F10 + dashboard one-liner). All read-side: no state machine, gate, or write-path changes.
