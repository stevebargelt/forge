---
id: FG-314
type: epic
status: active
title: "[EPIC] Integrate headroom context compression into forge"
---

**Goal:** Integrate headroom (https://github.com/chopratejas/headroom) context compression into forge to reduce token usage by 60-95% across agent runs.

**What headroom provides:**
- Content-aware compression: SmartCrusher (JSON), CodeCompressor (AST), Kompress-base (text/ML)
- Reversible compression (CCR) — originals cached, LLM can retrieve on demand
- Multiple integration modes: library (TypeScript/Python), proxy, MCP server, SDK wrappers
- Cross-agent memory with auto-dedup
- `headroom learn` — mines failed sessions, writes corrections to agent config files

**Integration strategy (hybrid approach):**

**Phase 1: Library compression (orchestrator-side)**
- Install `headroom-ai` npm package
- Add `compress()` calls in `src/v2/spawn.ts` to compress task packages before sending to agents
- Compress large system prompts (agent CLAUDE.md, constraints)
- Measure token savings per run

**Phase 2: MCP server (agent-side)**
- Add headroom MCP server to agent Docker image
- Update implementer seeds: "Use `headroom_compress` for tool outputs > 5KB"
- Orchestrator verifies compression metadata in `result.json`
- Safety net: if result > 20KB and no compression metadata, orchestrator compresses post-hoc + logs finding

**Phase 3: Proxy fallback**
- Add `compression_mode: proxy` config option for agent roles
- For agents that consistently fail to compress, spawn with headroom proxy sidecar
- Route API calls through proxy for transparent compression

**Phase 4: Cross-agent memory & learning**
- Evaluate headroom's cross-agent memory (potential collision with forge's SQLite state)
- Integrate `headroom learn` to mine failed forge runs and auto-update agent seeds

**Acceptance criteria:**
- Token usage reduced by ≥60% on large tool outputs (test runs, file reads, git logs)
- Agents can retrieve original context via CCR when needed
- No accuracy regression on agent tasks (compression preserves semantics)
- Dashboard shows compression stats per run

**Stories to file:**
- FG-315: Install headroom + orchestrator-side library compression (Phase 1)
- FG-316: Add headroom MCP to agent containers + seed instructions (Phase 2)
- FG-317: Orchestrator compression safety net + verification (Phase 2)
- FG-318: Proxy mode for non-compliant agents (Phase 3)
- FG-319: Evaluate cross-agent memory integration (Phase 4)
- FG-320: Integrate `headroom learn` with agent seed updates (Phase 4)

**Related:**
- FG-313 (dashboard integration idea)
- Headroom docs: https://headroom-docs.vercel.app/docs
- Headroom repo: https://github.com/chopratejas/headroom

**Open questions:**
- Does headroom's TypeScript library have feature parity with Python? (README suggests Python is more mature)
- How does CCR retrieval work in library mode vs MCP mode?
- What's the compression overhead (latency) per request?
- Does cross-agent memory conflict with forge's per-run SQLite isolation?