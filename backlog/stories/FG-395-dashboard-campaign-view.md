---
id: FG-395
type: story
status: active
title: "Dashboard Campaign View: overnight work progress and blockers"
epic: FG-370
created: 2026-06-24
---

## Problem

A polished campaign runner needs a dashboard surface. Humans should not need to run CLI commands in the morning to understand what Forge did overnight.

## Goal

Expose campaign state in the dashboard.

## Acceptance Criteria

- Add an API endpoint for campaigns and campaign detail.
- Campaign dashboard data reuses the existing campaign report contract where practical (`assembleCampaignReport` / `ReportResult`) rather than re-implementing done-audit, readiness, verdict, next-action, or git-state derivation in dashboard-only SQL.
- Show campaign progress, current item, blocked items, shipped items, skipped items, and completed items.
- Link campaign items to runs/tasks and backlog tickets.
- Surface blocker reasons and requested human actions.
- Surface readiness, done-audit, Shipping Reviewer, and verification state when available.
- Surface Campaign Report checkpoints and the final Campaign Report.
- **Surface per-item git evidence and PR-state visibility (FG-367 v1 evidence layer):**
  - `branch` and `worktreePath` (populated only for Forge-managed worktree runs; `null` otherwise — show the null/non-worktree case truthfully, do not imply Forge managed a branch it did not create);
  - closed commit / latest commit;
  - `prUrl` (currently always `null` in v1 — render as "no PR" / not-applicable, never a fake link);
  - derived push/PR states — `no_remote`, `not_pushed`, `unavailable` — sourced from done-audit / git facts (no new persisted state; one source of truth);
  - the clear operator action when Forge does not push / open PRs automatically (e.g. "no remote configured; push/PR unavailable", or the push/PR command for the operator to run).
- Empty/loading/error states are handled.
- Tests cover API shape for list + detail, project filtering or empty-state behavior, and at least one dashboard rendering path that includes a blocker/action plus git/PR evidence.

## Implementation Notes

- Existing campaign report source of truth: `src/campaign/report.ts` (`assembleCampaignReport`, `ReportResult`, `renderCampaignReportHuman`).
- Existing dashboard server/query pattern: `dashboard/src/server.ts`, `dashboard/src/queries.ts`.
- If the dashboard imports campaign report code, add a narrow dashboard path alias rather than duplicating campaign report semantics.
- Suggested read-only endpoints:
  - `GET /api/campaigns` — recent/active campaign summaries, optionally filtered by `projectDir`.
  - `GET /api/campaign/:id` — campaign detail using the same item/report shape as the CLI JSON report.
- Suggested client surface: add a `campaigns` dashboard tab/route, with a summary list and detail panel. Keep it read-only.

## Git / PR-state visibility (added post-FG-367)

Dashboard VISIBILITY ONLY — do NOT add auto-push or auto-PR (FG-367 v1 is deliberately conservative: no automation that changes remote state). The dashboard reflects what Forge actually managed and surfaces push/PR readiness truthfully, derived from done-audit/git facts. The git evidence fields and derived push/PR states above already exist on the campaign report (`branch`, `worktreePath`, `commit`, `prUrl`, and the no-remote requestedAction); this story renders them in the dashboard. Auto-push/auto-PR is a separate future opt-in, never hidden here.

## Non-Goals

- Do not add dashboard editing/reordering in the first version.
- Do not add Stream Deck integration here.
- Do not implement parallel lanes.
