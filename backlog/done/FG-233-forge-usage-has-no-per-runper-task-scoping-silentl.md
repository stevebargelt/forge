---
id: FG-233
type: story
status: done
title: forge usage has no per-run/per-task scoping; silently ignores a positional runId
---

**Closed:** 2026-06-01. Commit `0fb68bf`.

Hit during the AWN-7 Pixtron regression Test 2. `forge usage <runId>` returned the host-global aggregate (every role/run on the host) — the positional runId was silently ignored. usage.ts options are only --by / --since / --project / --json / --limit; there is no --run or --task filter and no positional, so an extra arg is dropped.

Two issues:
1. Silent-ignore is misleading — `forge usage <runId>` looks like it scoped but didn't. At minimum error on an unrecognized positional.
2. No way to get a single run's or task's token cost from the CLI. The model_calls rows carry task_id (and task->run_id), so the data is there; usageForTask() already reads per-task in code. The `forge usage` doc deliberately punts per-run UX to the dashboard, but a CLI/orchestrator session can't use the dashboard — a --run / --task filter is the cheap programmatic answer.

Proposal: add `--run <id>` and `--task <id>` filters to the usage WHERE clause (LEFT JOIN runs r is already there). Optionally `forge show <task> --usage` to fold the token row into the resolution view. Low-risk, additive.

Relevant to AWN-7 per-policy regression testing (wanting the engineer-vs-red per-provider cost in isolation).