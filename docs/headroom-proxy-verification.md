# Headroom Proxy Verification

This document explains how to verify that the headroom proxy integration is working correctly.

## Prerequisites

1. Headroom proxy installed and running:
   ```bash
   bash scripts/install-headroom.sh install
   bash scripts/install-headroom.sh start
   bash scripts/install-headroom.sh status  # should show "healthy"
   ```

2. Forge configured with default `compression_mode='proxy'` (default since 6888dac)

## Verification Steps

### 1. Verify Proxy is Running

```bash
curl http://localhost:8787/health
# Expected: {"status":"healthy","version":"1.0.0","config":{"optimize":true,"cache":true,"rate_limit":true}}

curl http://localhost:8787/stats | jq '.requests.total'
# Expected: 0 (if no requests have been made yet)
```

### 2. Verify Orchestrator Routes Through Proxy

Start a forge orchestrator session:

```bash
forge claude
# Expected output: "forge claude: routing through headroom proxy (v1.0.0)"
```

After the session starts and makes an LLM call, check proxy stats:

```bash
curl http://localhost:8787/stats | jq '{total: .requests.total, by_model: .requests.by_model, compressions: .telemetry.total_compressions}'
# Expected: total > 0, showing the orchestrator's requests
```

### 3. Verify Agent Routes Through Proxy

Run a simple agent invocation:

```bash
forge invoke architecture-advisor \
  --task "List 3 risks of using SQLite for multi-tenant SaaS" \
  --project "$(pwd)" \
  --run-title "Proxy verification test"

# Expected in output: "forge: headroom proxy healthy (v1.0.0)"
```

Check proxy stats again:

```bash
curl http://localhost:8787/stats | jq '{total: .requests.total, by_provider: .requests.by_provider, compressions: .telemetry}'
# Expected: total should have increased by the number of LLM calls the agent made
```

### 4. Verify Dashboard Shows Live Metrics

1. Start the dashboard:
   ```bash
   forge dashboard start
   ```

2. Navigate to http://localhost:8024/#compression

3. You should see:
   - **"🚀 Headroom Proxy Live"** banner at the top
   - Metrics: Tokens Saved, Savings %, Compressions, Avg Ratio, CCR Entries, CCR Retrievals
   - Numbers should update every 30 seconds

## Feature Verification

### CacheAligner

Check proxy logs for cache alignment activity:

```bash
tail -f ~/.forge/logs/headroom-proxy.log | grep -i "cachealigner\|dynamic"
```

Expected: Lines showing dynamic content detection and cache alignment when requests come through.

### ContentRouter

Check if the proxy is detecting content types:

```bash
curl http://localhost:8787/stats | jq '.telemetry'
```

The `tool_signatures_tracked` field shows how many unique tool signatures have been seen (indicates ContentRouter is working).

### CCR (Compress-Cache-Retrieve)

Check CCR statistics:

```bash
curl http://localhost:8787/stats | jq '.compression'
```

Expected fields:
- `ccr_entries`: Number of cached compressed contexts
- `ccr_retrievals`: Number of times cached context was retrieved
- `original_tokens_cached` vs `compressed_tokens_cached`: Shows compression ratio

### Code-Aware Compression

When an agent processes code, check the proxy logs:

```bash
grep "Code-Aware" ~/.forge/logs/headroom-proxy.log
```

Should show "LAZY" on startup, then "LOADED" when first code content is detected.

## Troubleshooting

### Proxy shows 0 requests

**Symptom:** Proxy stats show `total: 0` after running agents

**Check:**
1. Is `compression_mode='proxy'` in the runtime YAML?
   ```bash
   grep compression_mode ~/.forge/runtimes/claude.yml
   ```
   Expected: `compression_mode: proxy`

2. Are agents actually running, or failing early?
   ```bash
   forge status
   ```

3. Check agent container logs for connection errors:
   ```bash
   forge show <task-id>
   ```

### Orchestrator not routing through proxy

**Symptom:** `forge claude` doesn't show "routing through headroom proxy" message

**Check:**
1. Is proxy running?
   ```bash
   bash scripts/install-headroom.sh status
   ```

2. Check the `forge claude` source code has the proxy health check (commit c8cef9b or later)

3. Try starting with explicit base URL:
   ```bash
   ANTHROPIC_BASE_URL=http://localhost:8787 forge claude
   ```

### Proxy shows "unhealthy"

**Symptom:** `/health` endpoint returns non-healthy status

**Check proxy logs:**
```bash
tail -100 ~/.forge/logs/headroom-proxy.log
```

Common issues:
- LiteLLM SSL certificate warnings (cosmetic, doesn't break functionality)
- Python dependencies missing (re-run `scripts/install-headroom.sh install`)
- Port 8787 already in use (change `HEADROOM_PORT` env var)

## Success Criteria

✅ Proxy health check returns `{"status":"healthy"}`  
✅ `forge claude` shows "routing through headroom proxy"  
✅ Orchestrator requests appear in proxy stats  
✅ Agent invocations show "headroom proxy healthy" message  
✅ Agent requests appear in proxy stats  
✅ Dashboard "Headroom Proxy Live" banner appears  
✅ Dashboard metrics update with non-zero values  
✅ Proxy logs show CacheAligner, ContentRouter, CCR activity  

When all criteria are met, the integration is working correctly!
