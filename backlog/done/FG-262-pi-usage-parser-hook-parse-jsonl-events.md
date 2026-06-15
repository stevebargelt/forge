---
id: FG-262
type: story
status: done
title: "pi: usage-parser hook (parse JSONL events)"
---

**Closed:** 2026-06-06.

**Phase:** Crawl. Part of #258.
Implement a `log_format`-keyed usage parser for Pi's JSONL (per the spike's field mapping), extracting tokens/model/upstream-provider metadata into Forge's usage record. This is the architectural correction: Pi may run Anthropic, OpenAI, Groq, Ollama, etc., so upstream provider cannot select the parser.
**Acceptance:** parser unit-tested against the spike's committed sample stream; at least one live Pi JSONL stream captured and folded into the fixture before acceptance; a usage row is recorded for a Pi task.
**Depends on:** spike, runtime story.