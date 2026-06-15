---
id: FG-125
type: story
status: done
title: Implementer seeds don't mention `forge-test`; tests fail mysteriously in build phase
---

**Closed:** 2026-05-14. Commit `01ca91c`.

**Why:** Caught 2026-05-13 reviewing the System Map (#105) build phase output. The implementer ran `npm test` inside its container, got 203 pass / 143 fail (better-sqlite3 ELF mismatch — host's darwin-arm64 binary doesn't load on container's linux-amd64), and reported them as "pre-existing failures unrelated to this change." On the host they're 345/345 green.

**Root cause:** `seeds/agents/verifier/CLAUDE.md:28-38` documents `forge-test` (the wrapper that rebuilds better-sqlite3 in `/tmp/forge-work` per #111), but **none of the implementer seeds do**. Today's implementer happened to use forge-test for the new targeted test file (it discovered the wrapper somehow) but reverted to `npm test` for the full-suite check. Result: misleading failure numbers in result.json, confused agent narrative, no actual regression.

**Affected seeds:**
- `seeds/agents/implementer/CLAUDE.md`
- `seeds/agents/frontend-implementer/CLAUDE.md`
- `seeds/agents/backend-implementer/CLAUDE.md`
- `seeds/agents/infosec-implementer/CLAUDE.md`

**How to apply:** Copy the forge-test block from `seeds/agents/verifier/CLAUDE.md:23-40` (the "When running tests inside this container" section) into each implementer seed under its own testing guidance. Same language, same examples, same caveat about infra-vs-test failures. Plus an explicit "never run plain `npm test` — always `forge-test`" sentence; explicit-by-prohibition matches how #92 (architect scope) was tightened to good effect.

**Why this is worth doing right now (not waiting for #116):** every build phase between today and v2 hits this same gap. The fix is ~10 lines in 4 files. Low risk, high signal-to-noise improvement in result.json narratives. In v2 (#116), the per-runtime guidance might move to a different place (runtime YAML? per-step task_file?), but the *content* survives — agents need to know about forge-test regardless of how the orchestrator dispatches them.

**Caught:** 2026-05-13 — build phase result.json analysis.