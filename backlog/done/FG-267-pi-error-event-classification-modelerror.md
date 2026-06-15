---
id: FG-267
type: story
status: done
title: "pi: error-event classification -> model_error"
---

**Closed:** 2026-06-06.

**Phase:** Walk. Part of #258.
Map pi `auto_retry_*` / `errorMessage` events and provider errors to forge's `model_error` classification with the cause surfaced — extends #228.
**Acceptance:** a forced provider error on a pi task is classified `model_error` (not generic container_crash) with the cause string.
**Depends on:** usage-parser story.