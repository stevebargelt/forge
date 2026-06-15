---
id: FG-329
type: story
status: active
title: Implement full headroom proxy + SDK wrapper integration (replaces minimal compress() usage)
created: 2026-06-15
---

**Current state:** forge calls compress() from headroom-ai TypeScript SDK, but the headroom proxy is NOT running. This means forge only gets basic/fallback compression and NONE of the advanced features (CacheAligner, ContentRouter, SmartCrusher, CCR, hooks).

**Deployment blockers discovered 2026-06-15:**
- ❌ Corporate SSL inspection breaks both Python pip install AND Docker proxy→upstream connections
- ❌ headroom requires Rust compilation (SSL errors fetching rustup)
- ✅ Docker image pulls successfully
- ⚠️ Proxy starts but can't reach api.anthropic.com due to SSL cert validation failure

**Root cause:** headroom proxy acts as a passthrough proxy to Anthropic/OpenAI APIs. Corporate MITM SSL breaks this. The proxy needs to trust the corporate CA or disable SSL verification (not recommended).

**Revised implementation approach (works around SSL issues):**

## Option A: Local headroom install with corporate CA trust (recommended)

1. Install corporate CA bundle: export SSL_CERT_FILE=/path/to/corporate-ca.crt
2. Pre-install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
3. Install headroom with CA trust: `REQUESTS_CA_BUNDLE=$SSL_CERT_FILE pip install "headroom-ai[all]"`
4. Start proxy with CA trust: `SSL_CERT_FILE=$SSL_CERT_FILE headroom proxy --port 8787`
5. Update forge spawn.ts to use withHeadroom() wrapper with baseUrl: 'http://localhost:8787'

## Option B: Skip proxy, use SDK-only features (partial solution)

The headroom-ai TypeScript SDK might support some features without the proxy (CacheAligner, basic compression). Trade-offs:
- ✅ No proxy deployment needed
- ✅ Works in SSL-restricted environments  
- ❌ Missing SmartCrusher (requires proxy's ContentRouter)
- ❌ Missing CCR (requires proxy's storage)
- ❌ Missing cross-agent memory
- ❌ Missing intelligent context scoring

Check if SDK has standalone CacheAligner:
```typescript
import { compress } from 'headroom-ai';

const result = await compress(messages, {
  model: 'claude-sonnet-4-5',
  // Try these without proxy:
  cacheOptimizer: { enabled: true, autoDetectProvider: true },
  // ... other config
});
```

## Option C: Use headroom in CI/production only (hybrid)

- Dev/local: use current minimal compression (works now)
- CI/prod: deploy headroom proxy in Docker with proper certs
- Feature flag: `USE_HEADROOM_PROXY=1` enables full features

## Next steps (prioritized by feasibility):

1. **Investigate SDK-only features** — check if CacheAligner works without proxy (1-2 hours)
2. **Document corporate CA setup** — find where SGWS CA bundle lives, add to quick-start (2 hours)
3. **Test headroom proxy with CA trust** — retry Docker with SSL_CERT_FILE mounted (2 hours)
4. **Implement Option C (hybrid)** — flag-gated proxy usage for environments that support it (4 hours)
5. **Full integration (Option A)** — only after CA trust is working (8+ hours)

**Decision:** Pause FG-329 until SSL/CA path is clear. Current minimal compression works; don't block on deployment issues. Revisit when:
- Corporate CA bundle location identified
- headroom proxy successfully reaches api.anthropic.com
- OR SDK-only features confirmed viable

**References:**
- https://github.com/chopratejas/headroom#corporate--ssl-inspection-environments
- Docker image: ghcr.io/chopratejas/headroom:latest (pulled, v0.25.0)
- Proxy health endpoint returns SSL error: "unable to get local issuer certificate"