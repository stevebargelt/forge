# Plans

These are point-in-time implementation plans and closeout evidence artifacts. They
explain how a decision was executed; they are not the current source of delivery
priority or ticket state.

- Current ticket state: the backlog database and `forge backlog`
- Product and architecture intent: [`docs/prds/`](../prds/)
- Historical operator-plan snapshot:
  [`backlog/PLAN.md`](../../backlog/PLAN.md)

## Index

| Artifact | Lifecycle | Purpose |
|---|---|---|
| [FG-553 Slice 1 architecture and plan](fg553-slice1-architecture.md) | Shipped; historical plan | Durable-continuation Slice 1 architecture, decomposition, and implementation updates. |
| [FG-565 closeout evidence ledger](fg565-closeout-evidence-ledger.md) | Shipped in `1b3989e`; historical evidence | Durable-continuation closeout inventory and acceptance mapping. |
| [`fg553-probes/`](fg553-probes/) | Retained evidence | Raw probes supporting the FG-553 plan. |

Do not “refresh” a historical plan until it resembles current code. Add a short
lifecycle note when later work supersedes a premise, and put new intent in a PRD,
or ticket.
