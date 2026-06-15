---
id: FG-263
type: story
status: done
title: "pi: system-prompt / context injection mapping"
---

**Closed:** 2026-06-05.

**Phase:** Crawl (the novel design work). Part of #258.
Map `composeSystemPrompt` + constraints into pi. pi loads context from `.pi/SYSTEM.md` / `AGENTS.md` / `CLAUDE.md` (cwd + parents). Decide the injection path: write the composed system prompt to `.pi/SYSTEM.md` in the container vs prepend to the `-p` prompt; use `--no-context-files` so pi does not double-load the project's CLAUDE.md.
**Acceptance:** a pi agent receives forge's seed + constraints exactly once; red read-only project mount still enforced.
**Note:** likely needs an architecture-advisor consult; relates to #253 (provider adapter surfaces — SYSTEM.md/AGENTS.md as a generated adapter).
**Depends on:** runtime story.