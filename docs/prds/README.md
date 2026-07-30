# Product and architecture documents

The status line at the top of each document is authoritative. The body may be a
preserved original proposal and can contain point-in-time language.

## Lifecycle

- **Confirmed / in implementation:** accepted direction with active delivery work.
- **Shipped / historical:** implemented; retained as decision and design context.
- **Concept / roadmap:** useful exploration without implementation authority.

Current sequencing lives in [`backlog/PLAN.md`](../../backlog/PLAN.md), and ticket
state lives in the backlog database.

## Confirmed / in implementation

- None currently.

## Concept / roadmap

- [Reducing Forge Control-Plane Complexity](reducing-control-plane-complexity.md)
  — an exploratory direction, not an approved implementation plan.

## Shipped / historical

- [Build fanout and discipline routing](build-fanout-discipline-139.md)
- [Cross-project usability](cross-project-usability-138.md)
- [Dashboard as an npm workspace](dashboard-as-workspace-140.md)
- [Original dashboard PRD](dashboard-original.md)
- [Dashboard project colors](dashboard-project-color-143.md)
- [Durable orchestration continuation](durable-orchestration-continuation.md)
- [Evidence-Led Review Lifecycle](evidence-led-review-lifecycle.md) — all three
  changes shipped 2026-07-30 (FG-638 ledger → FG-639 coordinator → FG-640 gate
  and `feature`-workflow migration); the interim Change-0 policy is retired
- [Twilio notifications](notifications-twilio-142.md)
- [Twilio notification opt-in](notify-opt-in-145.md)
- [Provider-agnostic runtime and Pi pilot](provider-agnostic-runtime-pi.md)
- [RACI routing policy](raci-routing-policy.md)
- [Evidence-anchored red findings](reds-evidence-anchored-147.md)
- [System Map](system-map-105.md)
- [YAML-driven orchestrator](yaml-orchestrator-116.md)

Supporting spike material remains beside its parent PRD under [`pi-258/`](pi-258/).
