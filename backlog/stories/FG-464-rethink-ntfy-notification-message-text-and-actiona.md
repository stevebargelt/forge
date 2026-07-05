---
id: FG-464
type: story
status: active
title: Rethink ntfy notification message text and actionable detail
created: 2026-07-05
---

## Problem

Forge's current ntfy notification text is not very helpful in practice. The notification may tell the operator that something completed, failed, or needs attention, but it does not consistently answer the questions that matter when the operator is away from the terminal:

- What exactly happened?
- Which project/run/task/campaign does this belong to?
- Is this actionable now or just informational?
- What should I do next?
- Is the work merged/closed, awaiting a gate, blocked by review, failed due infrastructure, or still recoverable?

Prior notification work exists and is closed:

- FG-169 added optional ntfy push notifications.
- FG-207 enriched run-transition notifications with failure kind and a `forge show` next-command.
- FG-234 added per-run notification policy.

This ticket is a new UX/content pass over the notification text. It should not duplicate the provider plumbing; it should make the messages useful.

## Goal

Redesign Forge's ntfy notification copy so a notification is compact, actionable, and trustworthy at a glance. The implementation should use existing durable facts where possible and avoid inventing unsupported detail.

## Initial Direction

Before implementation, collect a few examples of the current notifications the operator receives and compare them against desired examples. The final shape can be decided from those examples, but likely useful fields include:

- project name
- run title / ticket id / campaign id when available
- role or phase that changed state
- terminal status or gate state
- failure kind / blocker kind when present
- short human action label, e.g. "review gate", "inspect failure", "merge PR", "resume campaign", "no action"
- copy-pasteable next command such as `forge show <task>` or `forge campaign show <id>`

## Acceptance Criteria

- ntfy messages are rewritten around an operator-action model: what happened, where, and next action.
- Message text remains short enough for push-notification scanning; avoid verbose reports.
- Run/task notifications include the most useful available identifiers without overwhelming the message.
- Failure/blocker notifications include failure kind, blocker kind, or recovery hint when available.
- Non-actionable completion notifications are clearly distinguishable from human-action-needed notifications.
- Campaign-related notifications, if currently emitted, include campaign id/item/ticket context where available.
- `forge notify test` or an equivalent test surface demonstrates the new formatting without requiring a real run.
- Tests cover representative cases: success, failure with failure_kind, blocked/gate/manual attention, campaign context if supported, and missing optional data.
- Docs/how-to notification examples are updated if current docs show stale message text.

## Non-Goals

- Does not add a new notification provider.
- Does not require changing notification delivery policy or subscription setup.
- Does not invent GitHub/PR/campaign facts that are not already available to the formatter.
- Does not make notifications noisy; improving detail should not mean emitting more notifications.

## Open Product Input

The exact copy should be refined from real examples. Capture:

- examples of what the operator currently receives;
- examples of what the operator wishes those messages said;
- whether the operator prefers terse one-line pushes or slightly richer multi-line ntfy messages.
