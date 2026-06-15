---
id: FG-328
type: story
status: active
title: Headroom integration is minimal — missing CCR, CacheAligner, ContentRouter, hooks, and advanced config (FG-314 gap analysis)
created: 2026-06-15
---

FG-314 shipped basic headroom integration (compress() for >20KB results), but forge only uses ~5% of headroom's capabilities. Major gaps:

**Current forge integration:**
- ✅ Basic compress() call for text >20KB
- ✅ Compression metrics (size, ratio, method)
- ✅ forge learn command (custom implementation)
- ✅ Dashboard compression UI

**Missing headroom features (high-value):**

1. **CCR (Content-Compressed Representation)** — reversible compression
   - Headroom stores originals, LLM retrieves via headroom_retrieve tool
   - Forge's compression is one-way; no retrieval path for agents
   - Impact: Agents can't ask for full context when compressed version is ambiguous

2. **CacheAligner** — stabilizes prefixes for provider KV cache hits
   - Detects dynamic content (timestamps, IDs, paths), segregates to tail
   - Normalizes whitespace, collapses blank lines
   - Impact: Forge misses Anthropic/Bedrock prompt caching opportunities

3. **ContentRouter** — auto-detects content type, picks best compressor
   - SmartCrusher for JSON (preserves structure, 60-92% savings on tool outputs)
   - CodeCompressor for AST (Python/JS/Go/Rust/Java/C++)
   - Kompress-base for prose
   - Forge treats everything as text, so JSON tool outputs compress poorly

4. **Hooks & lifecycle events** — on_compress_start, on_compress_complete, etc.
   - Forge has no hooks; can't customize compression behavior per agent/phase
   - Would enable: per-agent compression policies, metrics collection, audit trails

5. **Advanced config** — ToolCrusherConfig, RollingWindowConfig, ScoringWeights
   - Forge uses defaults; no tuning for forge's multi-agent patterns
   - ToolCrusher would help with JSON-heavy build/red agents
   - RollingWindow would preserve recent turns + system message
   - ScoringWeights would prioritize errors, recent context, semantic similarity

6. **IntelligentContext** — score-based context fitting
   - Weighs recency, semantic similarity, error indicators
   - Forge's compression is all-or-nothing; no selective pruning

7. **Cross-agent memory** — shared store, agent provenance, auto-dedup
   - Headroom can share compressed context across agents
   - Forge re-compresses identical context per agent

8. **Image compression** — 40-90% reduction via ML router
   - Headroom compresses images in agent inputs
   - Forge doesn't handle images yet (#browser-tools screenshots)

9. **MCP server mode** — headroom_compress, headroom_retrieve, headroom_stats
   - Forge could expose compression as MCP tools for agents
   - Would enable agents to compress their own outputs before returning

**Recommended next steps (prioritized):**

1. **CacheAligner** (high ROI) — forge invoke runs hit Bedrock/Anthropic caching; aligning prefixes would improve cache hit rate and reduce latency
2. **ContentRouter** (med ROI) — red agents + test-engineer produce JSON-heavy results; SmartCrusher would compress better than text compression
3. **CCR + headroom_retrieve** (low-med ROI) — reversible compression is elegant but requires LLM to call a tool; adds complexity
4. **Hooks** (low-med ROI) — useful for per-agent tuning, but current defaults work
5. **Advanced config** (low ROI) — tuning after we have more compression event data

**Decision:** FG-314 should remain ACTIVE until at least CacheAligner + ContentRouter land. Current compression works but leaves major value on the table.

**References:**
- https://github.com/chopratejas/headroom
- https://headroom-docs.vercel.app/docs/architecture
- https://headroom-docs.vercel.app/docs/ccr
- node_modules/headroom-ai/dist/index.d.ts (TypeScript API surface)