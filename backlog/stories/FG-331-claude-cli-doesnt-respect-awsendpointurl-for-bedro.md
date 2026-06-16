---
id: FG-331
type: story
status: active
title: Claude CLI doesn't respect AWS_ENDPOINT_URL for Bedrock proxy routing
created: 2026-06-16
---

## Problem

The headroom-proxy Rust binary is installed, configured, and running correctly. forge's spawn.ts correctly passes AWS_ENDPOINT_URL env vars to agent containers when compression_mode=proxy. However, Bedrock requests from the Claude CLI bypass the proxy entirely and go directly to AWS bedrock-runtime service.

## Evidence

**Test run:** run-bedrock-end-to-end-test-1c39b5
- Task completed successfully (created hello.txt)
- Container logs show `amazon-bedrock-invocationMetrics` (direct Bedrock responses)
- Container logs show `msg_bdrk_*` message IDs (Bedrock format)
- Proxy logs show ZERO POST /model/{model}/invoke requests during the task
- Test script verified env vars ARE passed: AWS_ENDPOINT_URL=http://localhost:8787, AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://localhost:8787

## Root Cause

AWS SDK (used by Claude CLI for Bedrock) doesn't respect the global AWS_ENDPOINT_URL environment variable for Bedrock service calls. The SDK requires service-specific endpoint configuration that may not be exposed via env vars, or the Claude CLI needs to explicitly configure the Bedrock client to use custom endpoints.

## Options

1. **Ask Anthropic:** Does Claude CLI support custom Bedrock endpoints? May need a feature request.
2. **Network-level proxy:** Use HTTP_PROXY/HTTPS_PROXY env vars instead of AWS endpoint override (requires proxy to handle HTTPS/TLS)
3. **SDK client patch:** Modify agent container entrypoint to patch AWS SDK client initialization (brittle, version-dependent)
4. **Accept limitation:** Document that Bedrock doesn't route through compression proxy; only Anthropic/OpenAI API calls compress

## Impact

FG-328's Bedrock routing goal is blocked. The Rust proxy has native Bedrock support (SigV4 signing, /model/{model}/invoke handler), but can't intercept requests from the Claude CLI.

## Related

- FG-330: Original investigation (closed - runtime YAML works correctly)
- FG-328: Headroom integration (Bedrock native support)
- commit 32becda: Added AWS_ENDPOINT_URL to spawn.ts (code is correct, SDK doesn't honor it)
