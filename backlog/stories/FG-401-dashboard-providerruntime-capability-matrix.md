---
id: FG-401
type: story
status: active
title: Dashboard Provider/Runtime Capability Matrix
epic: FG-291
created: 2026-06-24
---

## Problem

Forge behavior depends on provider, runtime, auth profile, project config, dependency availability, worktree support, and workflow requirements. Today those capability gaps are mostly discovered by failed runs or CLI diagnostics.

Claude Deck makes provider-specific capability gaps visible. Forge needs the same honesty, expressed in Forge terms.

## Goal

Expose a dashboard Provider/Runtime Capability Matrix that shows what the current project and configured runtimes/providers can actually do.

## Acceptance Criteria

- Dashboard shows configured providers/runtimes and their current readiness.
- Matrix includes auth availability and diagnostic status where Forge can determine it without spending tokens unnecessarily.
- Matrix indicates support/availability for usage accounting, structured output, worktree mode, host-test/dependency parity, browser/E2E capability, filesystem mode, hooks/tool guards, and resume/handoff support where applicable.
- Matrix indicates whether each relevant workflow can run with the current provider/runtime/project setup.
- Matrix indicates whether Shipping Reviewer and Campaign Runner prerequisites are available, unavailable, or deferred.
- Capability gaps are shown as explicit statuses with reasons, not hidden as generic failures.
- Data is source-of-truth-aware: distinguish configured, detected, inferred, unavailable, and unknown.
- JSON/API shape is stable enough for dashboard, campaign reports, and optional operator-surface addons.
- Tests cover at least one ready provider/runtime, one missing-auth case, one unsupported capability, and one unknown/deferred capability.

## Non-Goals

- Do not add a new provider.
- Do not implement config editing.
- Do not implement Campaign Runner or Shipping Reviewer.
- Do not run expensive live model calls just to populate the matrix.

## Notes

- Origin: Claude Deck competitive research visibility and safety sections.
- Related: FG-291, FG-253, FG-349, FG-372, FG-395, FG-387.
