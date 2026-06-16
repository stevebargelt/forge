---
id: FG-314
type: epic
status: done
title: "[EPIC] Integrate headroom context compression into forge"
closed: 2026-06-16
---

**Goal:** Integrate headroom (https://github.com/chopratejas/headroom) context compression into forge to reduce token usage by 60-95% across agent runs.

**What headroom provides:**
- Content-aware compression: SmartCrusher (JSON), CodeCompressor (AST), Kompress-base (text/ML)
- Reversible compression (CCR) — originals cached, LLM can retrieve on demand
- Multiple integration modes: library (TypeScript/Python), proxy, MCP server, SDK wrappers
- Cross-agent memory with auto-dedup
- `headroom learn` — mines failed sessions, writes corrections to agent config files

**STATUS UPDATE 2026-06-16:** Phases 1-3 complete. Proxy running, dashboard integrated.

**Integration strategy (hybrid approach):**

**Phase 1: Library compression (orchestrator-side)** ✅ DONE
- Install `headroom-ai` npm package ✓
- Add `compress()` calls in spawn.ts to compress task packages ✓
- Compress large system prompts (agent CLAUDE.md, constraints) ✓
- Measure token savings per run ✓
- Dashboard shows compression stats ✓

**Phase 2: MCP server (agent-side)** ✅ DONE (replaced with proxy mode)
- ~~Add headroom MCP server to agent Docker image~~ (proxy mode chosen instead)
- ~~Update implementer seeds with compression instructions~~ (not needed for proxy)
- Orchestrator verifies compression metadata in result.json ✓
- Safety net: orchestrator compresses large results post-hoc ✓

**Phase 3: Proxy mode** ✅ DONE
- Proxy installation script with start/stop/status commands ✓ (ec8fcf5)
- Default compression_mode='proxy' ✓ (6888dac)
- Dashboard integration with live metrics ✓ (5ebe3b0, 71e001d)
- Agents route LLM calls through localhost:8787 ✓
- Health checks before spawning agents ✓

**Phase 4: Cross-agent memory & learning** ⏸️ DEFERRED
- Evaluate headroom's cross-agent memory (potential collision with forge's SQLite state)
- Integrate `headroom learn` to mine failed forge runs and auto-update agent seeds
- **Decision:** Custom `forge learn` command shipped (FG-320) instead of using headroom's. Cross-agent memory deferred pending real multi-agent usage data.

**Acceptance criteria:**
- ✅ Token usage reduced by ≥60% on large tool outputs
- ⏸️ Agents can retrieve original context via CCR (not implemented yet)
- ✅ No accuracy regression on agent tasks
- ✅ Dashboard shows compression stats per run

**Completed stories:**
- FG-315: ✅ Install headroom + orchestrator-side library compression (Phase 1)
- FG-316: ✅ Add headroom MCP to agent containers (replaced by proxy mode)
- FG-317: ✅ Orchestrator compression safety net + verification (Phase 2)
- FG-318: ✅ Proxy mode for non-compliant agents (Phase 3)
- FG-319: ✅ Evaluate cross-agent memory integration (Phase 4 - decided against)
- FG-320: ✅ Integrate `forge learn` with agent seed updates (custom implementation)
- FG-329: ✅ Full proxy + SDK wrapper integration (Phase 3 completion)

**Outstanding work (FG-328):**
Advanced headroom features not yet implemented:
- CacheAligner for Bedrock/Anthropic KV cache optimization
- ContentRouter for smart JSON/code compression
- CCR retrieval tool for agents
- Hooks and lifecycle events
- Advanced config tuning
- Cross-agent memory
- Image compression

**Decision:** Mark FG-314 as COMPLETE with current baseline. Advanced features tracked in FG-328 can be pursued independently if ROI justifies it.

**Related:**
- FG-313 (dashboard integration) — CLOSED
- FG-328 (gap analysis for advanced features) — ACTIVE
- Headroom docs: https://headroom-docs.vercel.app/docs
- Headroom repo: https://github.com/chopratejas/headroom