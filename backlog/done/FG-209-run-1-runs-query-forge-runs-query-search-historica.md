---
id: FG-209
type: story
status: done
title: "RUN-1 runs-query: forge runs query — search historical runs by status, failure_kind, project, age"
---

**Closed:** 2026-05-30. Commit `2b3fc82`.

Observability RUN stage §1 (docs/observability.md). CLI query over ~/.forge/forge.db to answer operational questions:
- Which tasks hit idle_timeout this week?
- Which projects have the most auth failures?
- Which runs were cancelled manually?

Command (per doc):
  forge runs query --failure-kind idle_timeout --since 7d
  forge runs query --project ~/code/app --status abandoned
  forge runs query --json

Filters: --status, --failure-kind, --project, --since <Nd|all>, --workflow. --json for orchestrator consumption.

Notes:
- No schema change. failure_kind lives in task.failed event payloads (Crawl decision), so filtering by failure_kind means scanning events per task — reuse failureKindForTask (failure-kind.ts). For hundreds of runs that's fine in-process.
- Reuse the --since window parser pattern from usage.ts. Cross-project by default (like the dashboard), with --project to scope.
- Pure query helpers in a testable module; thin CLI wrapper. Stable JSON schema.