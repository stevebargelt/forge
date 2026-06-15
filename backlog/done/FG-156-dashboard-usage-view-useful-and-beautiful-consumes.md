---
id: FG-156
type: story
status: done
title: "Dashboard usage view: useful AND beautiful (consumes #155)"
---

**Closed:** 2026-05-27.

Follow-up to #155, which shipped the data layer (capture + backfill + CLI). User flagged that 1-5 are a waste without the dashboard view — 6 is the payoff.

**Why "useful AND beautiful":** the CLI proves the data is sound, but the rollup table isn't acted on at-a-glance. The dashboard needs to surface the actionable signals in a way that drives behavior change (which model to use where; which workflow has cache churn; which project is burning tokens).

**The actionable signals from the data we now have:**
- Total spend (weighted tokens) per project / workflow / model / role
- Cache hit rate trends — has it improved since the workflow YAML downgrades shipped?
- Cache reuse ratio — flags workflows where cache is being created and discarded
- Per-step model mix (post-#117 audit: confirm Opus burn is dropping)
- Time series: weighted tokens per day per project (rolling 30d)

**Design considerations (think hard before building):**
- **Headline metric first.** What's the single number on the page? Probably "weighted tokens last 7 days" with a delta vs prior 7 days. Or cache hit rate.
- **Comparison is the value.** Project A vs B; workflow X vs Y. Side-by-side bars or sparklines, not just numbers.
- **Drill-down hierarchy.** Click a project → see workflows. Click a workflow → see roles. Click a role → see tasks.
- **Time series.** A flat-roll snapshot tells you what's true now; the trend tells you whether the calibration is working.
- **Cache efficiency callouts.** Workflows with hit rate < 80% or reuse ratio < 5x should be visually flagged.
- **No dollar amounts.** This is unitless / weighted-tokens. Dollar conversion is brittle and OAuth users have no per-token cost — don't pretend.

**Implementation surface:**
- Dashboard server: new \`/api/usage\` endpoint with query params for the four rollup dimensions + time filters. Reuse the SQL shape from src/cli/commands/usage.ts.
- Dashboard client: new \`<UsageView />\` tab alongside activity / projects. Top-of-tab: headline metric + comparison chart. Below: per-dimension breakdowns with sparklines.
- Maybe a "what changed" tile: workflow YAML edits from #117 + this view side-by-side, watching the spec-writer → default migration's effect in real time.

**Composes with:**
- #155 — the data layer this consumes
- #154 — the existing dashboard Projects view; pattern-match the card grid + chip styling
- 0088737 commit — the workflow downgrades whose effect this measures

**Sequencing:** ship soon. User explicitly flagged this as essential and the CLI alone isn't act-on-able.

**Caught:** 2026-05-26 conversation while shipping #155.