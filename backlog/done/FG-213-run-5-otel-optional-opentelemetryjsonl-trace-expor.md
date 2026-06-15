---
id: FG-213
type: story
status: done
title: "RUN-5 otel: optional OpenTelemetry/JSONL trace export from forge events"
---

**Closed:** 2026-05-30. Commit `92fa722`.

Observability RUN stage §5 (docs/observability.md). After the internal trace shape is stable, add export options. The WALK-2 spanKind groundwork (run|task|docker|model|tool|auth|gate|red-review on events) is the hook.

  forge export --run <id> --format jsonl       # one event per line
  forge export --run <id> --format otel        # OTLP spans (run→task→… hierarchy)

Scope (do JSONL first — trivial, no deps): dump eventsForRun as JSONL with runId/taskId/spanKind/timestamp/payload. OTel is the stretch: map run→root span, task→child spans, lifecycle events→span events/status; emit OTLP JSON (no collector required — file output). Keep it an EXPORT path, not the source of truth. Redact payloads (no secrets — payloads are already booleans/safe text by Crawl discipline, but double-check).

Lowest priority; capstone. JSONL slice is high-value-low-cost; OTel can be deferred.