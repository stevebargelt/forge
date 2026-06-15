---
id: FG-200
type: story
status: done
title: "forge show: stdout/stderr tail dumps raw stream-json blobs — extract text deltas instead"
---

**Closed:** 2026-06-07.

#196's forge show task view tails the last ~5 lines of container.stdout.log. For Claude agent containers the log is stream-json — each 'line' is a huge JSON object, so the 'Last stdout' block renders 5 giant unreadable blobs instead of useful recent activity.

Polish: when the log looks like Claude stream-json (JSONL with type fields), extract the human-readable text — the assistant text deltas / the final result.result string — and show that as the tail, capped to a sane width/line count. Fall back to raw tail for non-JSON logs (plain CLI/test output). Keep it in show.ts's tailLines/last-output rendering. Pure-function-friendly so it stays unit-testable like the other #196 helpers. Low priority — cosmetic, not blocking.