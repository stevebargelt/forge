---
name: forge-campaign
description: Plan, approve, run, and recover multi-ticket Forge campaigns via `forge campaign`. Use when the operator wants an ordered set of backlog tickets (an epic or an explicit list) executed end-to-end, instead of dispatching one ticket at a time.
---

# forge-campaign

A campaign is a persisted, ordered set of backlog tickets that forge works one item at a time through a workflow (default `feature`: architect → tech-lead → engineer → Shipping Reviewer → done-audit). Source of truth for exact flags: `forge campaign --help` (each subcommand also has its own `--help`). For full semantics — precondition tables, blocker kinds, stop reasons — read `docs/concepts.md` (search "## Campaign").

## Non-goal

This is a host/orchestrator skill only. It documents a CLI you run from the terminal. Containerized agents do not discover or read `.claude/skills`; nothing here changes in-container agent behavior.

## Lifecycle

```
forge campaign plan   (--tickets <ids> | --epic <id> [--add/--exclude]) [--mode dry_run|pilot|sequential] [--project <dir>]
forge campaign approve <campaign-id> --rationale <text> [--by <operator>]
forge campaign start   <campaign-id> [--project <dir>]
forge campaign pause   <campaign-id>
forge campaign resume  <campaign-id> [--project <dir>]
forge campaign reconcile <campaign-id> [--by <operator>]
forge campaign abandon <campaign-id>
forge campaign show    <campaign-id>       # read-only
forge campaign report  <campaign-id>       # read-only
```

- **plan** resolves tickets/epic input into a persisted campaign (`planned` status) with a stable `plan_hash`. Defaults to `--mode dry_run`, which is plan-and-report only — `start` refuses a dry-run campaign. Use `--mode pilot` or `--mode sequential` to make it executable.
- **approve** records a durable, rationale-bearing approval and snapshots the current plan hash as the baseline `start` re-verifies. This is a required precondition — `start` refuses an unapproved campaign.
- **start** / **resume** drive the campaign one item at a time and block until the run stops — on completion, on a paused state (a human gate, a failing/inconclusive red verdict, an unready ticket, or an operator-requested pause), or on a hard failure. Both are resumable: `resume` reattaches to a parked item and continues, it does not re-dispatch or retry a failed item outright.
- **reconcile** is the operator-recovery path for a paused campaign with `scope`-blocked items: it re-derives outcomes from durable evidence (ticket/git/host-verification/event records) — it does not accept an operator override as evidence.
- **abandon** is terminal and irreversible; it only applies to a non-terminal campaign (not `complete`/`failed`/already `abandoned`).
- **show** and **report** are read-only inspection — use them to see the active item, held/blocked items, and the `Next action` guidance before deciding whether to resume, reconcile, or abandon.

## Resumable-stepper behavior

A campaign pauses between items rather than mid-item — the in-flight item finishes (or parks at a gate/verdict) before the pause takes effect. When it pauses, it's always for a specific, inspectable reason (readiness-held ticket, dependency-held item, blocked item, human gate, or a cooperative operator pause) — `forge campaign show` names the item and the action needed. Treat a paused campaign as the normal steady state of a long-running campaign, not an error condition.

## When to reach for this vs a single run

Use `forge campaign` when you have more than one ticket to work in a defined order and want durable plan/approval/resume state. For a single ticket, drive it directly with `forge new`/`forge next`/`forge gate` (see `docs/quick-start.md`) rather than wrapping it in a one-item campaign.
