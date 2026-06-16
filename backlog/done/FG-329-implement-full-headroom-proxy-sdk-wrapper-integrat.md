---
id: FG-329
type: story
status: done
title: Implement full headroom proxy + SDK wrapper integration (replaces minimal compress() usage)
created: 2026-06-15
closed: 2026-06-16
---

**Completed 2026-06-16.** Headroom proxy integration phases 1-3 shipped.

**What landed:**

**Phase 1 (ec8fcf5):** Installation infrastructure
- `scripts/install-headroom.sh`: multi-command script (install/start/stop/restart/status)
- `scripts/run-headroom-proxy.sh`: background service runner (follows SSO watchdog pattern)
- Python venv setup at `~/.forge/headroom-env`
- Logs to `~/.forge/logs/headroom-proxy.log`

**Phase 2 (6888dac):** Default mode switch
- `compression_mode` default changed from 'mcp' to 'proxy' in schema.ts
- `check-proxy.ts`: health check with 2s timeout
- `invoke.ts`: pre-flight proxy health check (warns if down but doesn't block)
- Agents now route LLM calls through localhost:8787 when proxy is running

**Phase 3 (5ebe3b0, 71e001d):** Dashboard integration
- `ProxyHealthBanner` component shows live metrics when proxy is running
- Dashboard polls `/api/compression/proxy/stats` and `/v1/telemetry` every 30s
- Server proxies requests to localhost:8787
- Graceful degradation if proxy isn't running (banner hidden on 503)

**Current capabilities:**
- Proxy running on localhost:8787, status: healthy
- Dashboard shows tokens saved, savings %, compressions, avg ratio, CCR entries/retrievals
- Basic optimization enabled (cache, rate limiting, code-aware compression)

**Not implemented (tracked in FG-328):**
- CacheAligner for Bedrock/Anthropic KV cache hit optimization
- ContentRouter for smart JSON/code compression routing
- CCR retrieval tool for agents
- Hooks and lifecycle events
- Advanced config tuning (ToolCrusher, RollingWindow, ScoringWeights)
- Cross-agent memory
- Image compression

**Next:** FG-328 for advanced features, or consider FG-314 epic complete with current baseline.