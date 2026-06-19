---
id: FG-331
type: story
status: done
title: Claude CLI doesn't respect AWS_ENDPOINT_URL for Bedrock proxy routing
created: 2026-06-16
closed: 2026-06-19
---

## Conclusion

**Verified:** The Claude CLI (2.1.153) does NOT respect `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` environment variable for routing Bedrock requests through a custom endpoint.

### Evidence

1. **spawn.ts works correctly:** Sets `AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://localhost:8787` in agent containers
2. **Headroom proxy works correctly:** Has native Bedrock handler at `/model/{model_id}/invoke`, SigV4 re-signing, compression
3. **Proxy receives zero Bedrock requests:** Test runs show `amazon-bedrock-invocationMetrics` in container logs (direct AWS responses), but proxy logs show zero `/model/...` requests
4. **HTTP_PROXY doesn't work:** Proxy receives `CONNECT` requests but returns 501 - headroom is a transparent reverse proxy, not an HTTP tunnel proxy
5. **Direct endpoint test worked:** Spawn test verified all env vars are passed correctly to containers

### Why This Matters

AWS SDK v3 SHOULD honor `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` per AWS documentation. Either:
- Claude CLI uses older SDK without endpoint env var support
- CLI has hardcoded endpoint configuration
- This is an intentional limitation

### Recommendation

**File with Anthropic:** Feature request to support custom Bedrock endpoints via `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` environment variable. This would enable:
- Request routing through compression proxies (like headroom)
- Local/VPC Bedrock endpoints
- Testing/development scenarios

### Workarounds

None currently viable:
- ❌ `AWS_ENDPOINT_URL` global: not honored by Bedrock SDK
- ❌ `HTTP_PROXY`: headroom doesn't support CONNECT tunneling
- ❌ Network-level routing: would require iptables/DNS hijacking (too invasive)

### Impact on FG-328

Bedrock integration via headroom proxy is **blocked** until CLI supports custom endpoints. Anthropic/OpenAI API compression works; Bedrock compression does not.
