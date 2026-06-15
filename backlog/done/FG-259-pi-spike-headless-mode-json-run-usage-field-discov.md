---
id: FG-259
type: story
status: done
title: "pi: spike — headless --mode json run + usage-field discovery"
---

**Closed:** 2026-06-04. Commit `1e5e019`.

**Phase:** Spike (de-risk). Part of #258.
De-risks the one hard unknown: pi's token-usage fields are undocumented.
Run pi with one API-key provider, `pi -p "<prompt>" --mode json`, capture the JSONL stream. Identify which event(s) carry input/output token counts, the model/provider actually used, and stop reason; confirm `agent_end` is the completion signal.
**Acceptance:** a documented mapping pi-JSON-event -> {input_tokens, output_tokens, model, stop_reason} sufficient to write the parser, plus a captured sample event stream committed as a test fixture. No production code.
**Blocks:** the usage-parser story.