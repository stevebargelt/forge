**Last session ended 2026-06-16.**

**Where we left off:** FG-328 Rust proxy implementation complete, but discovered runtime YAML configuration loading bug (FG-330) preventing Bedrock requests from routing through the proxy.

**Picked up next:**
1. **FG-330: Runtime YAML compression_mode not loading** — RuntimeSchema.safeParse() shows compression_mode as null despite explicit YAML field in ~/.forge/runtimes/claude-bedrock.yml. Investigate loader.ts line 107, verify Zod default behavior, check manifest vs actual runtime object. Once fixed, Bedrock routing will work (spawn.ts code already in place).
2. **Kill dummy upstream server** — `kill $(cat /tmp/dummy-upstream.pid)` and remove scripts/run-headroom-proxy.sh temporary upstream change (localhost:8788). Restore to proper configuration once proxy health check works correctly.
3. **Verify Bedrock proxy routing end-to-end** — After FG-330 fix: invoke with Bedrock mode, check proxy logs for POST /model/{model}/invoke requests, verify compression + SigV4 signing, close FG-328.

**External state to remember:**
- Rust headroom-proxy binary installed at ~/.forge/bin/headroom-proxy (23MB), built with ONNX Runtime
- Proxy running on localhost:8787 (PID may vary), health endpoint: /healthz
- Dummy upstream server on localhost:8788 (PID in /tmp/dummy-upstream.pid) — TEMPORARY, needs cleanup
- test-engineer container task-test-engineer-0d1ca4 may still be running (was 40+ min) — check/kill if stuck

**Decisions worth not relitigating:**
- Rust proxy over Python: Native Bedrock support confirmed working, build complexity resolved with ONNX Runtime + dynamic linking automation
- One-line spawn.ts change: AWS_ENDPOINT_URL env var is correct approach (proxy accepts Bedrock API format at /model/{model}/invoke)
- Runtime YAML investigation required: Not a proxy issue, not a spawn.ts issue — loader.ts Zod parsing problem (FG-330)
- Compression mode in all runtimes: Added explicitly to claude-*.yml files as workaround (should work via schema default but doesn't)

**Shipped (for reference):**
- 91de1ea: Initial Rust proxy integration (install script, run script, docs)
- 0e2123e: ONNX Runtime build fix (Homebrew + dynamic linking)
- 72fada2: Integration tests for proxy install (12/12 passed in container)
- 7a850a7: Backlog updates (FG-328 status)
- 32becda: Bedrock routing spawn.ts change (blocked by FG-330)
- FG-330: Filed ticket for runtime YAML loading bug

## FG-330 Investigation Results (2026-06-16)

**Root cause identified:** NOT a runtime YAML loading bug - that works correctly. The actual issue is that AWS SDK in Claude CLI doesn't respect AWS_ENDPOINT_URL for Bedrock requests.

**Verified working:**
✓ Runtime YAML parsing: compression_mode: proxy loads correctly
✓ Zod schema validation: RuntimeSchema.safeParse() works
✓ spawn.ts proxy block: if (runtime.compression_mode === "proxy") executes  
✓ Env vars passed to container: AWS_ENDPOINT_URL, AWS_ENDPOINT_URL_BEDROCK_RUNTIME, FORGE_HEADROOM_PROXY=1 all present

**Actual problem:**
✗ Claude CLI AWS SDK bypasses the proxy entirely
✗ Bedrock requests go directly to bedrock-runtime.us-east-1.amazonaws.com
✗ Proxy logs show zero POST /model/{model}/invoke requests
✗ Container logs show amazon-bedrock-invocationMetrics (direct Bedrock responses)

**Why this happens:**
The AWS SDK's global AWS_ENDPOINT_URL env var doesn't work for all services. Bedrock requires service-specific endpoint configuration that the Claude CLI may not support, or requires additional SDK client config beyond env vars.

**Next steps:**
1. Check if Claude CLI supports custom Bedrock endpoints (may need Anthropic to add support)
2. Alternative: proxy at network level (HTTP_PROXY/HTTPS_PROXY) instead of AWS endpoint override
3. Or: patch the SDK client initialization in the agent container entrypoint
