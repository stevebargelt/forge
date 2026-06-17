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

## FG-331 Deep Dive (2026-06-16)

**Headroom proxy Bedrock support IS correctly implemented:**
- Proxy has native Bedrock handler at POST /model/{model_id}/invoke
- Takes Anthropic-shaped bodies, compresses, re-signs with SigV4
- Forwards to bedrock-runtime.{region}.amazonaws.com
- Verified with --help: --enable-bedrock-native=true (default), --bedrock-region, etc.

**The gap: AWS SDK endpoint configuration**
spawn.ts correctly sets:
- AWS_ENDPOINT_URL=http://localhost:8787
- AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://localhost:8787

BUT these env vars may not be supported by the Claude CLI's AWS SDK version, or Bedrock service specifically ignores them.

**Possible solutions:**
1. **HTTP_PROXY approach**: Set HTTP_PROXY/HTTPS_PROXY env vars - AWS SDK respects standard proxy vars
2. **Check Claude CLI AWS SDK version**: May need SDK upgrade to support endpoint env vars
3. **SDK client config**: CLI may need explicit endpoint configuration in code, not just env vars
4. **Ask Anthropic**: Does Claude Code 2.1.153 support custom Bedrock endpoints?

**Next action:** Try HTTP_PROXY approach as it's the most standard way to intercept AWS SDK requests.

## BREAKTHROUGH: FG-331 Solution Exists! (2026-06-16)

**Found active PR that solves our exact problem:**
- PR #720: https://github.com/chopratejas/headroom/pull/720
- Author: rongabbay (same use case as us - uses `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`)
- Status: OPEN (not yet merged)
- Real proof: 52,095 → 3,979 tokens (92.4%) compression working with CLI

**What the PR adds:**
`--bedrock-api-url` flag to headroom proxy that registers routes at:
- POST /model/{id}/invoke
- POST /model/{id}/invoke-with-response-stream

When CLI sets `AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://localhost:8787`, requests should hit these routes.

**Why our test failed:**
The current headroom-proxy binary (Rust) doesn't have this feature yet. PR #720 is for the Python proxy. We need to either:
1. Wait for PR merge + release
2. Build from PR branch (chopratejas/headroom#720)
3. Check if Rust proxy has equivalent (issue #953 suggests Rust needs adapters too)

**Critical caveat from PR:**
Rewriting body invalidates SigV4 signature. Needs downstream gateway that re-signs. For direct AWS: use `--backend bedrock` (different mode).

**Related issues:**
- #510: Provider-agnostic proxy mode (umbrella issue)
- #953: Bedrock vendor adapter registry for Rust proxy
- #734: Original feature request for Bedrock passthrough

**Next step:** Verify which proxy we're running (Python vs Rust) and determine path forward.

## FG-331 Further Investigation (2026-06-17)

**Progress made:**
- Fixed proxy upstream: now points to real API instead of dummy localhost:8788
- Rebuilt headroom-proxy from source (main, commit 0dc2e1cb) - includes us./eu./global. prefix fix
- Fixed proxy listen address: 0.0.0.0 so containers can reach it
- Fixed spawn.ts: containers now use host.docker.internal:8787 not localhost:8787
- Fixed check-proxy.ts: uses /healthz endpoint, correct response shape

**New finding:**
CLI does partially respect AWS_ENDPOINT_URL_BEDROCK_RUNTIME:
- Startup discovery calls (/inference-profiles?type=SYSTEM_DEFINED) DO route through proxy
- But actual model invocations (POST /model/{id}/invoke-with-response-stream) go DIRECTLY to AWS
- This is NOT a forge configuration issue - the CLI splits behavior:
  - Service discovery: honors endpoint override
  - Model inference: uses native AWS SDK credential chain, ignores endpoint override

**Conclusion:** CLI's inference calls bypass AWS_ENDPOINT_URL_BEDROCK_RUNTIME. This is a CLI behavior, not configurable from the forge side. Blocked by upstream.

**State:** headroom-proxy binary rebuilt with vendor prefix fix. All forge-side changes correct. Blocked on CLI behavior for actual inference routing.
