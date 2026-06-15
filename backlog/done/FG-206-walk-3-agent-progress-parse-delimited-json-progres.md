---
id: FG-206
type: story
status: done
title: "WALK-3 agent-progress: parse delimited JSON progress lines from agent stdout into task.progress/artifact/decision events"
---

**Closed:** 2026-05-30. Commit `1ea53d3`.

Observability WALK stage, §2 (docs/observability.md:331).

Agents MAY (not must) emit structured progress records as clearly-delimited JSON
lines on stdout. Forge parses them into events. If an agent never emits them,
forge still works from container lifecycle + logs — this is purely additive.

Example agent lines (JSONL on stdout):
  {"type":"progress","message":"installed dependencies","percent":25}
  {"type":"progress","message":"running unit tests","percent":60}
  {"type":"artifact","kind":"screenshot","path":"/task/homepage.png"}
  {"type":"decision","summary":"using existing auth profile qa-admin"}

These become NEW event types: task.progress, task.artifact, task.decision.
(Adding event types → update EventType union in src/store/events.ts AND ensure a
real emission path, per the no-dead-enum invariant established in Crawl.)

Implementation notes:
- Parse from container.stdout.log. Claude agent logs are stream-json already
  (#200), so the progress lines must be distinguishable from the assistant
  stream — define a clear delimiter/shape and only parse lines that match it.
- Reuse / coordinate with the captureUsageForTask stdout-scan pass rather than
  adding a second full-file read (bounded — don't slurp multi-MB logs; see the
  Crawl bounded-tail fix).
- Redact: progress payloads are agent-authored — never persist secrets; cap sizes.

Acceptance:
- Well-formed progress/artifact/decision lines become task.progress/artifact/
  decision events, readable via eventsForTask and rendered in forge show timeline.
- Malformed or absent progress lines are ignored without failing the task.
- New event types have real emission paths + unit tests.