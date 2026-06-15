---
id: FG-264
type: story
status: done
title: "pi: first role end-to-end through pi (Crawl exit)"
---

**Closed:** 2026-06-05.

**Phase:** Crawl exit criterion. Part of #258.
Route one role (e.g. a red on a cheap provider like Groq/Cerebras, or engineer on a chosen model) through the pi runtime and complete a real task end-to-end: dispatch -> pi -> result.json -> usage captured -> gate.
**Acceptance:** a full forge task completes via pi with correct status + usage and output-schema parity with claude/codex tasks.
**Depends on:** Docker image, runtime, usage parser, system-prompt mapping.