---
id: FG-450
type: story
status: done
title: "Dashboard: Forge Fleet in Motion marquee stats band"
created: 2026-07-03
closed: 2026-07-19
---

## Problem

Forge has no catchy, human-legible "the whole factory in motion" surface. The dashboard has ops, usage, project, and activity views, but it does not present a compact proof strip that shows the factory operating across projects.

Inspiration: a marketing-style fleet stats band such as Gas City's "factory fleet in motion" cards: "% PRs merged within 24 hours", "median time to merge", "peak day", and "repos in the fleet". Forge should have close equivalents, grounded in Forge receipts.

## Goal

A dashboard marquee "Forge Fleet in Motion" band that renders a small set of catchy cross-project aggregate stats. The first implementation should prefer stats computable from Forge's local data, and may include GitHub/PR-derived stats when that data is available. Numbers must be defensible, time-windowed, and explainable from receipts.

## Candidate Headline

"The Forge factory fleet in motion"

Alternative names are fine if they fit the dashboard tone.

## Candidate Metrics

Prefer 4-6 cards for the first cut. Exact set should be refined during design based on what is reliably computable.

Forge-native cards that can be computed from local SQLite/backlog data without GitHub authentication:

- `N projects in the Forge fleet` (from project registry).
- `N runs completed in the last 7/30 days`.
- `% terminal runs completed cleanly`.
- `median time from run created -> complete`.
- `N agent tasks completed`.
- `N adversarial reviews run` and/or `N blocking findings caught`.
- `N host verifications recorded` / `% shipped items with host verification`.
- `N campaign items shipped` / `N campaigns completed or in progress`.
- `N tokens processed` / cache-read token share, if usage data is present and can reuse FG-369 logic.
- `Peak day: N runs completed or tickets shipped on <date>`.

GitHub/PR-derived cards when repository remotes and GitHub data are available:

- `% PRs merged within 24 hours` across Forge-managed repos.
- `median time to merge a PR`.
- `N PRs merged on <date>, peak day`.
- `N public GitHub repos in the Forge fleet`.

## Data Source Guidance

- Forge-native stats should come from existing Forge data sources: runs, tasks, gates, verdicts, model_calls, campaigns, campaign_items, host_verifications, structured backlog, and project registry.
- GitHub/PR stats are optional in the first cut unless a reliable source is available. If implemented, derive repos from project GitHub remotes (shared with FG-438) and fetch/cached PR data via GitHub API or `gh` without blocking normal dashboard polling.
- Stats that are not reliably computable from current data should be dropped or split into a capture follow-up. Do not fake or silently approximate numbers.

## Acceptance Criteria

- The dashboard renders a marquee stats band with a curated set of cross-project Forge fleet stats.
- Dashboard exposes a read-only stats endpoint or extends an existing dashboard query with a compact fleet-stats payload.
- Each stat has:
  - value
  - short label
  - time window or scope text
  - data source / receipt hint, so the number is explainable rather than vibes.
- The first implementation works without GitHub authentication by using Forge-local data.
- If GitHub PR data is unavailable, the UI falls back to Forge-native equivalents rather than showing empty/broken cards.
- If GitHub PR stats are included, PR data is fetched/cached outside the hot dashboard poll path and auth/rate-limit/missing-access cases degrade to a clear unavailable state.
- Stats are cross-project by default, with an optional project filter if it fits existing dashboard patterns.
- Computation is efficient: reuse/extend existing aggregate queries where possible; no N+1 per-project shelling on every poll.
- Tests cover metric calculations for at least: project count, completed runs in window, success/clean rate, median duration, peak day, and missing-data fallback.
- Labels are concise and operator-facing, e.g. "83 runs completed on 2026-07-02, peak day" rather than raw schema terminology.

## Non-Goals

- Does not require public hosting.
- Does not require paid GitHub API access or mandatory GitHub authentication.
- Does not replace detailed ops/usage dashboards; this is the headline proof strip.
- Does not fabricate PR metrics when GitHub data is unavailable.
- Does not duplicate FG-369 token/cost rollup logic; reuse it if usage stats appear in the band.

## Refs / Relationships

- Canonical ticket superseding FG-449.
- Natural home: FG-400 Dashboard Forge Home / Operator Overview.
- Related to FG-395 Dashboard Campaign View.
- Related to FG-369 usage/cost visibility.
- Related to FG-438 project cards linking to GitHub repos.
- Builds on existing `forge metrics`, dashboard ops metrics, usage metrics, project registry, campaigns, and host_verifications data.

## Disposition — 2026-07-19

Closed as subsumed by the shipped Dashboard Home/Operations surface. The current 30-day band exposes the core operator-facing fleet proof—success rate, runs, tasks, retries, cancels, idle kills, and red blocks—without retaining a second overlapping dashboard story.
