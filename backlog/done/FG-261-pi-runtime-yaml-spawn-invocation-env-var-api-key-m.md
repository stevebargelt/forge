---
id: FG-261
type: story
status: done
title: "pi: runtime YAML + spawn invocation (env-var API-key mode)"
---

**Closed:** 2026-06-05.

**Phase:** Crawl. Part of #258.
Add `seeds/runtimes/pi-apikey.yml` mirroring `codex-subscription.yml`; wire spawn to run `pi -p "<prompt>" --mode json --no-context-files --provider X --model Y` and capture stdout JSONL. Auth: pass the provider API key as an env var into the container.
**Acceptance:** a `forge invoke` bound to the pi runtime dispatches a container that runs pi and returns captured output.
**Depends on:** #292 runtime metadata shape, Docker-image story.