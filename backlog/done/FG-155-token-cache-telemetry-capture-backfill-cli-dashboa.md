---
id: FG-155
type: story
status: done
title: "Token + cache telemetry: capture, backfill, CLI, dashboard view"
---

**Closed:** 2026-05-26. Data layer shipped (scope items 1-5). model_calls table reshaped with task_id/input/output/cache_read/cache_creation columns; cost dropped. Parser handles stream-json, dedupes by request_id, prefers message_delta totals; 11 tests cover edge cases. Capture wired into both spawn paths (invoke + runNext) as best-effort. forge usage backfill walked 175 historical task logs and inserted 5,139 rows; 146 tagged with alias via tasks-table lookup. forge usage CLI rollups across role/workflow/project/model/alias with cache hit rate + reuse ratio + weighted-tokens columns. Real data: claude-opus-4-7 = 76% of total weighted spend pre-workflow-downgrades; 96.7% cache hit rate corpus-wide; 29.6x reuse ratio. Dashboard view in follow-up #156 ("1-5 are a waste without 6").

Replaces #27's intent (which closed 2026-05-26 as "LiteLLM unreliable").

**Why:** Today's audit showed meatgeekv2 ran 78% of tasks on Opus when most could have been Sonnet (workflow YAMLs hardcoded \`model: spec-writer\` everywhere). Workflows were patched in commit \`0088737\`, but the only way to validate the change — and calibrate the next round — is data. Forge has a half-built \`model_calls\` table (schema present, 0 rows, never instrumented).

**The break:** claude-code already streams structured JSON to container.stdout.log via \`--output-format=stream-json\` (all three runtimes). Every assistant message includes \`usage\` with input/output/cache_read/cache_creation token counts. Every request's \`message_delta\` event has the canonical final usage with an \`iterations\` array. **Backfill is possible** — every existing run on disk has this data.

**Scope (this ticket = 1-5; dashboard view ships as separate ticket):**

1. Schema migration. \`model_calls\` gets \`task_id\` (FK to tasks), \`cache_read_tokens\`, \`cache_creation_tokens\`. Drop \`cost\` (we're not tracking dollars; OAuth has no per-token cost and price drift makes hardcoded tables stale).
2. Parser. \`extractUsageFromStdoutLog(path) → UsageRow[]\` — walks the stream-json, dedupes by \`request_id\`, takes the final \`message_delta\` usage per request.
3. Capture. spawn.ts at task-completion: parse the log, insert rows tagged with task_id.
4. Backfill. \`forge usage backfill\` walks ~/.forge/runs/*/task-*/container.stdout.log and populates historical (~hundreds of tasks become real data points).
5. CLI: \`forge usage\` with \`--by role|workflow|project|model\` rollups. Headline columns: input tokens, output tokens, cache hit rate (cache_read / (cache_read + cache_creation + input)), cache reuse ratio (cache_read / cache_creation), weighted-tokens (proxy for relative spend without committing to dollars). \`--since 7d\` time filter. \`--json\` for programmatic use.

**Out of scope this ticket (separate next ticket — must follow soon):**
- **Dashboard usage view.** Useful AND beautiful — cache efficiency as headline, cross-project / cross-workflow / cross-model comparisons, drill-downs, time series. The CLI from #5 proves the data; dashboard makes it act-on-able. The user explicitly flagged that 1-5 are a waste without 6 — file follow-up ticket immediately upon shipping this.

**Caught:** 2026-05-26 conversation about why meatgeekv2 was burning Opus.